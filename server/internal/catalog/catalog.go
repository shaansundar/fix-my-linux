// Package catalog holds Zen's model list and prices (from the models.dev
// catalog opencode uses) and derives what each plan may use.
package catalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"slices"
	"sync"
	"time"

	"fixmylinux.app/server/internal/usage"
)

// Rates are USD per million tokens.
type Rates struct {
	Input      float64  `json:"input"`
	Output     float64  `json:"output"`
	CacheRead  *float64 `json:"cache_read,omitempty"`
	CacheWrite *float64 `json:"cache_write,omitempty"`
}

type Tier struct {
	Rates
	Tier struct {
		Type string `json:"type"`
		Size int64  `json:"size"`
	} `json:"tier"`
}

type Cost struct {
	Rates
	Tiers []Tier `json:"tiers,omitempty"`
}

type Limit struct {
	Context int64 `json:"context"`
	Input   int64 `json:"input,omitempty"`
	Output  int64 `json:"output"`
}

// Model is one catalog entry; Raw is re-served to the desktop verbatim.
type Model struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Status   string `json:"status,omitempty"`
	ToolCall bool   `json:"tool_call"`
	Cost     *Cost  `json:"cost,omitempty"`
	Limit    Limit  `json:"limit"`
	Raw      json.RawMessage
}

func (m *Model) UnmarshalJSON(b []byte) error {
	type plain Model
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return fmt.Errorf("failed to parse model: %w", err)
	}
	*m = Model(p)
	m.Raw = append(json.RawMessage(nil), b...)
	return nil
}

// Free reports whether the model costs nothing.
func (m Model) Free() bool {
	return m.Cost != nil && m.Cost.Input == 0 && m.Cost.Output == 0
}

// Usable reports whether the agent can use the model at all.
func (m Model) Usable() bool {
	return m.Status != "deprecated" && m.ToolCall
}

func (r Rates) cacheRead() float64 {
	if r.CacheRead != nil {
		return *r.CacheRead
	}
	return r.Input
}

func (r Rates) cacheWrite() float64 {
	if r.CacheWrite != nil {
		return *r.CacheWrite
	}
	return r.Input
}

// RatesFor picks the rates for a prompt of the given size (context tiers).
func (c Cost) RatesFor(promptTokens int64) Rates {
	rates := c.Rates
	best := int64(-1)
	for _, t := range c.Tiers {
		if t.Tier.Type == "context" && promptTokens > t.Tier.Size && t.Tier.Size > best {
			rates, best = t.Rates, t.Tier.Size
		}
	}
	return rates
}

// CostMicros is the price of a call in micro-USD. Rates are $/1M tokens, so
// tokens × rate is already micro-dollars.
func (m Model) CostMicros(u usage.Usage) int64 {
	if m.Cost == nil {
		return 0
	}
	r := m.Cost.RatesFor(u.PromptTotal())
	total := float64(u.Input)*r.Input + float64(u.Output)*r.Output +
		float64(u.CacheRead)*r.cacheRead() + float64(u.CacheWrite)*r.cacheWrite()
	return int64(math.Ceil(total))
}

// WorstCaseMicros bounds a request's cost before it runs: every prompt token
// at the uncached input rate plus the maximum output.
func (m Model) WorstCaseMicros(promptTokens, maxOutput int64) int64 {
	if m.Cost == nil {
		return 0
	}
	if maxOutput <= 0 || (m.Limit.Output > 0 && maxOutput > m.Limit.Output) {
		maxOutput = m.Limit.Output
	}
	r := m.Cost.RatesFor(promptTokens)
	return int64(math.Ceil(float64(promptTokens)*r.Input + float64(maxOutput)*r.Output))
}

// Provider is the `opencode` provider entry of the catalog.
type Provider struct {
	Fields map[string]json.RawMessage
	Models map[string]Model
}

func (p *Provider) UnmarshalJSON(b []byte) error {
	if err := json.Unmarshal(b, &p.Fields); err != nil {
		return fmt.Errorf("failed to parse provider: %w", err)
	}
	raw, ok := p.Fields["models"]
	if !ok {
		return errors.New("provider has no models")
	}
	delete(p.Fields, "models")
	if err := json.Unmarshal(raw, &p.Models); err != nil {
		return fmt.Errorf("failed to parse models: %w", err)
	}
	return nil
}

// Subset re-encodes the provider with only the given models, in models.dev format.
func (p *Provider) Subset(ids []string) (json.RawMessage, error) {
	out := make(map[string]json.RawMessage, len(p.Fields)+1)
	for k, v := range p.Fields {
		out[k] = v
	}
	models := make(map[string]json.RawMessage, len(ids))
	for _, id := range ids {
		if m, ok := p.Models[id]; ok {
			models[id] = m.Raw
		}
	}
	encoded, err := json.Marshal(models)
	if err != nil {
		return nil, fmt.Errorf("failed to encode models: %w", err)
	}
	out["models"] = encoded
	b, err := json.Marshal(out)
	if err != nil {
		return nil, fmt.Errorf("failed to encode provider: %w", err)
	}
	return b, nil
}

// FreeModels lists usable free models, preferred ones first.
func (p *Provider) FreeModels(preference []string) []string {
	var ids []string
	for id, m := range p.Models {
		if m.Free() && m.Usable() {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	return preferred(ids, preference)
}

func preferred(ids, preference []string) []string {
	out := make([]string, 0, len(ids))
	for _, id := range preference {
		if slices.Contains(ids, id) {
			out = append(out, id)
		}
	}
	for _, id := range ids {
		if !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// PlanKind is what a user's entitlement allows.
type PlanKind string

const (
	PlanTrial PlanKind = "trial"
	PlanPaid  PlanKind = "paid"
)

// PlanConfig is the operator's model curation.
type PlanConfig struct {
	PaidModels     []string
	PaidDefault    string
	PaidSmall      string
	FreePreference []string
}

// Plan mirrors the desktop's ModelPlan.
type Plan struct {
	DefaultModel string   `json:"defaultModel"`
	SmallModel   string   `json:"smallModel"`
	Allowed      []string `json:"allowed"`
}

// Allowed lists the model IDs a plan may call.
func (p *Provider) Allowed(kind PlanKind, cfg PlanConfig) []string {
	if kind == PlanTrial {
		return p.FreeModels(cfg.FreePreference)
	}
	var ids []string
	for _, id := range cfg.PaidModels {
		if m, ok := p.Models[id]; ok && m.Usable() {
			ids = append(ids, id)
		}
	}
	return ids
}

// PlanFor picks the default and small models for a plan.
func (p *Provider) PlanFor(kind PlanKind, cfg PlanConfig) (Plan, error) {
	allowed := p.Allowed(kind, cfg)
	if len(allowed) == 0 {
		return Plan{}, fmt.Errorf("no models available for the %s plan", kind)
	}
	plan := Plan{DefaultModel: allowed[0], SmallModel: allowed[0], Allowed: allowed}
	if kind == PlanPaid {
		if slices.Contains(allowed, cfg.PaidDefault) {
			plan.DefaultModel = cfg.PaidDefault
		}
		if slices.Contains(allowed, cfg.PaidSmall) {
			plan.SmallModel = cfg.PaidSmall
		}
	}
	return plan, nil
}

// Fetcher loads the current provider catalog.
type Fetcher func(ctx context.Context) (*Provider, error)

// HTTPFetcher reads the opencode provider from a models.dev api.json URL.
func HTTPFetcher(client *http.Client, url string) Fetcher {
	return func(ctx context.Context) (*Provider, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to build catalog request: %w", err)
		}
		res, err := client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch catalog: %w", err)
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("failed to fetch catalog: status %d", res.StatusCode)
		}
		var all map[string]json.RawMessage
		if err := json.NewDecoder(res.Body).Decode(&all); err != nil {
			return nil, fmt.Errorf("failed to decode catalog: %w", err)
		}
		raw, ok := all["opencode"]
		if !ok {
			return nil, errors.New("catalog has no opencode provider")
		}
		var p Provider
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
		return &p, nil
	}
}

// Service caches the catalog and refreshes it periodically.
type Service struct {
	fetch   Fetcher
	mu      sync.RWMutex
	current *Provider
}

func NewService(fetch Fetcher) *Service {
	return &Service{fetch: fetch}
}

// Refresh replaces the cached catalog; on failure the previous one stays.
func (s *Service) Refresh(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	p, err := s.fetch(ctx)
	if err != nil {
		return fmt.Errorf("failed to refresh catalog: %w", err)
	}
	s.mu.Lock()
	s.current = p
	s.mu.Unlock()
	return nil
}

// Run refreshes every interval until ctx ends; errors go to onError.
func (s *Service) Run(ctx context.Context, interval time.Duration, onError func(error)) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := s.Refresh(ctx); err != nil && onError != nil {
				onError(err)
			}
		}
	}
}

// Provider returns the cached catalog, or false before the first successful fetch.
func (s *Service) Provider() (*Provider, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current, s.current != nil
}
