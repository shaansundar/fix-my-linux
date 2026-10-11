// Package proxy forwards the desktop's model calls to OpenCode Zen with our
// key, enforcing the plan's model list, the trial's daily cap and the
// subscriber's monthly budget, and records what each call cost.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"fixmylinux.app/server/internal/catalog"
	"fixmylinux.app/server/internal/entitlement"
	"fixmylinux.app/server/internal/store"
	"fixmylinux.app/server/internal/usage"
)

// Ledger is the usage bookkeeping the proxy needs.
type Ledger interface {
	Reserve(ctx context.Context, h store.Hold) (string, bool, error)
	Settle(ctx context.Context, reservationID string, rec store.UsageRecord) error
	Release(ctx context.Context, reservationID string) error
	RecordUsage(ctx context.Context, rec store.UsageRecord) error
	RequestsSince(ctx context.Context, userID string, since time.Time) (int, error)
}

type Catalog interface {
	Provider() (*catalog.Provider, bool)
}

// Account is the caller, resolved by the HTTP layer.
type Account struct {
	UserID      string
	Entitlement entitlement.Entitlement
}

// ErrSignedOut means the bearer token is missing or revoked.
var ErrSignedOut = errors.New("signed out")

// Resolver authenticates a request and loads its entitlement.
type Resolver func(r *http.Request) (Account, error)

type Config struct {
	// Zen's base URL, e.g. https://opencode.ai/zen/v1
	Upstream     string
	ZenKey       string
	BudgetMicros int64
	// Model calls a trial account may make per UTC day.
	TrialDailyRequests int
	Plans              catalog.PlanConfig
	Client             *http.Client
	Logger             *slog.Logger
	// Largest request body accepted.
	MaxBody int64
	// How long an in-flight call may run, including after the client leaves.
	CallTimeout time.Duration
	// Clock for usage records and holds; time.Now by default.
	Now func() time.Time
}

type Proxy struct {
	cfg     Config
	ledger  Ledger
	catalog Catalog
	resolve Resolver
	now     func() time.Time
}

func New(cfg Config, ledger Ledger, cat Catalog, resolve Resolver) *Proxy {
	if cfg.Client == nil {
		cfg.Client = &http.Client{}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.MaxBody == 0 {
		cfg.MaxBody = 32 << 20
	}
	if cfg.CallTimeout == 0 {
		cfg.CallTimeout = 15 * time.Minute
	}
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Proxy{cfg: cfg, ledger: ledger, catalog: cat, resolve: resolve, now: now}
}

// Request headers worth passing to Zen; everything else (cookies, the
// client's credentials, hop-by-hop headers) is dropped. Accept-Encoding is
// left to Go's transport so responses arrive decompressed for the usage parser.
var forwardHeaders = []string{
	"Content-Type", "Accept", "User-Agent",
	"Anthropic-Version", "Anthropic-Beta", "Openai-Beta", "X-Stainless-Helper-Method",
}

var hopByHop = map[string]bool{
	"Connection": true, "Keep-Alive": true, "Proxy-Authenticate": true, "Proxy-Authorization": true,
	"Te": true, "Trailer": true, "Transfer-Encoding": true, "Upgrade": true, "Content-Length": true,
}

func writeError(w http.ResponseWriter, status int, code, message string, resetsAt *time.Time) {
	body := map[string]any{"code": code, "message": message}
	if resetsAt != nil {
		body["resets_at"] = resetsAt.UTC().Format(time.RFC3339)
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": body})
}

func modelFrom(path string, body []byte) string {
	if i := strings.Index(path, "/models/"); i >= 0 {
		rest := path[i+len("/models/"):]
		if j := strings.IndexByte(rest, ':'); j >= 0 {
			return rest[:j]
		}
	}
	var v struct {
		Model string `json:"model"`
	}
	_ = json.Unmarshal(body, &v)
	return strings.TrimPrefix(v.Model, "opencode/")
}

// maxOutputFrom reads the requested output cap in any adapter's spelling.
func maxOutputFrom(body []byte) int64 {
	var v struct {
		MaxTokens           int64 `json:"max_tokens"`
		MaxCompletionTokens int64 `json:"max_completion_tokens"`
		MaxOutputTokens     int64 `json:"max_output_tokens"`
		GenerationConfig    *struct {
			MaxOutputTokens int64 `json:"maxOutputTokens"`
		} `json:"generationConfig"`
	}
	_ = json.Unmarshal(body, &v)
	switch {
	case v.MaxCompletionTokens > 0:
		return v.MaxCompletionTokens
	case v.MaxTokens > 0:
		return v.MaxTokens
	case v.MaxOutputTokens > 0:
		return v.MaxOutputTokens
	case v.GenerationConfig != nil:
		return v.GenerationConfig.MaxOutputTokens
	}
	return 0
}

// The only Zen endpoints the proxy forwards to; anything else (including
// dot-segments that would reach other opencode.ai paths with our key) is refused.
var endpointPath = regexp.MustCompile(`^/(chat/completions|responses|messages|models/[A-Za-z0-9._-]+:(streamGenerateContent|generateContent))$`)

// Query parameters the adapters use; the rest are dropped.
var allowedQuery = map[string]bool{"alt": true}

// Roughly 3 bytes of JSON per prompt token; deliberately high for safety.
func promptEstimate(body []byte) int64 { return int64(len(body))/3 + 1 }

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	acct, err := p.resolve(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "signed_out", "Sign in to continue.", nil)
		return
	}
	ent := acct.Entitlement
	if !ent.CanUse() {
		msg := "Your free trial has ended. Subscribe to keep using Fix My Linux."
		switch ent.Reason {
		case entitlement.ReasonNoTrial:
			msg = "This computer already used its free trial. Subscribe to keep using Fix My Linux."
		case entitlement.ReasonPaymentIssue:
			msg = "There's a problem with your payment. Update your card to continue."
		}
		writeError(w, http.StatusPaymentRequired, ent.Reason, msg, nil)
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "", nil)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/zen/v1")
	format := usage.FormatFor(path)
	if format == usage.FormatUnknown || !endpointPath.MatchString(path) {
		writeError(w, http.StatusNotFound, "not_found", "", nil)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, p.cfg.MaxBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "That request is too large.", nil)
		return
	}

	provider, ok := p.catalog.Provider()
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "catalog_unavailable", "The assistant is briefly unavailable. Try again in a minute.", nil)
		return
	}
	modelID := modelFrom(path, body)
	if !slices.Contains(provider.Allowed(ent.Plan, p.cfg.Plans), modelID) {
		writeError(w, http.StatusForbidden, "model_not_allowed", "That model isn't included in your plan.", nil)
		return
	}
	model := provider.Models[modelID]

	ctx := r.Context()
	var reservation string
	var estimate int64
	switch ent.Plan {
	case catalog.PlanTrial:
		n, err := p.ledger.RequestsSince(ctx, acct.UserID, ent.PeriodStart)
		if err != nil {
			p.cfg.Logger.Error("count trial requests", "err", err)
			writeError(w, http.StatusInternalServerError, "internal", "", nil)
			return
		}
		if n >= p.cfg.TrialDailyRequests {
			end := ent.PeriodEnd
			writeError(w, http.StatusTooManyRequests, "daily_limit", "You've reached today's free limit. It resets tomorrow, or subscribe for more.", &end)
			return
		}
	case catalog.PlanPaid:
		estimate = model.WorstCaseMicros(promptEstimate(body), maxOutputFrom(body))
		id, ok, err := p.ledger.Reserve(ctx, store.Hold{
			UserID:      acct.UserID,
			Amount:      estimate,
			Budget:      p.cfg.BudgetMicros,
			PeriodStart: ent.PeriodStart,
			ExpiresAt:   p.now().Add(p.cfg.CallTimeout + time.Minute),
		})
		if err != nil {
			p.cfg.Logger.Error("reserve budget", "err", err)
			writeError(w, http.StatusInternalServerError, "internal", "", nil)
			return
		}
		if !ok {
			end := ent.PeriodEnd
			writeError(w, http.StatusTooManyRequests, "budget_exhausted", "You've used this month's assistant allowance. It resets on your next billing date.", &end)
			return
		}
		reservation = id
	}

	p.forward(w, r, path, format, body, acct.UserID, model, reservation, estimate)
}

func (p *Proxy) forward(w http.ResponseWriter, r *http.Request, path string, format usage.Format, body []byte, userID string, model catalog.Model, reservation string, estimate int64) {
	// Zen bills a call even if the person stops it, so the upstream call
	// outlives the client connection and is always read to the end.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), p.cfg.CallTimeout)
	defer cancel()

	query := url.Values{}
	for k, vs := range r.URL.Query() {
		if allowedQuery[k] {
			query[k] = vs
		}
	}
	target := strings.TrimRight(p.cfg.Upstream, "/") + path
	if q := query.Encode(); q != "" {
		target += "?" + q
	}
	// The host is fixed by config and path/query were allowlisted in ServeHTTP.
	up, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body)) // #nosec G704 -- target is cfg.Upstream + an allowlisted endpoint path
	if err != nil {
		p.finish(userID, model, reservation, estimate, usage.Usage{}, false, false)
		writeError(w, http.StatusInternalServerError, "internal", "", nil)
		return
	}
	for _, h := range forwardHeaders {
		if v := r.Header.Get(h); v != "" {
			up.Header.Set(h, v)
		}
	}
	switch format {
	case usage.FormatMessages:
		up.Header.Set("X-Api-Key", p.cfg.ZenKey)
	case usage.FormatGemini:
		up.Header.Set("X-Goog-Api-Key", p.cfg.ZenKey)
	default:
		up.Header.Set("Authorization", "Bearer "+p.cfg.ZenKey)
	}

	res, err := p.cfg.Client.Do(up) // #nosec G704 -- see NewRequestWithContext above
	if err != nil {
		p.cfg.Logger.Warn("upstream request failed", "err", err)
		p.finish(userID, model, reservation, estimate, usage.Usage{}, false, false)
		writeError(w, http.StatusBadGateway, "upstream_unreachable", "The assistant service didn't answer. Try again in a moment.", nil)
		return
	}
	defer res.Body.Close()

	for k, vs := range res.Header {
		if hopByHop[http.CanonicalHeaderKey(k)] {
			continue
		}
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(res.StatusCode)

	stream := strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream")
	parser := usage.NewParser(format, stream)
	flusher, _ := w.(http.Flusher)
	clientGone := false
	buf := make([]byte, 32<<10)
	for {
		n, readErr := res.Body.Read(buf)
		if n > 0 {
			_, _ = parser.Write(buf[:n])
			if !clientGone {
				if _, err := w.Write(buf[:n]); err != nil {
					clientGone = true
				} else if flusher != nil {
					flusher.Flush()
				}
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				p.cfg.Logger.Warn("upstream stream ended early", "err", readErr)
			}
			break
		}
	}

	u, found := parser.Result()
	ok := res.StatusCode >= 200 && res.StatusCode < 300
	p.finish(userID, model, reservation, estimate, u, found, ok)
}

// finish records the call's cost and releases the budget hold.
func (p *Proxy) finish(userID string, model catalog.Model, reservation string, estimate int64, u usage.Usage, found, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if !ok {
		if reservation != "" {
			if err := p.ledger.Release(ctx, reservation); err != nil {
				p.cfg.Logger.Error("release hold", "err", err)
			}
		}
		return
	}
	rec := store.UsageRecord{
		UserID: userID, Model: model.ID,
		Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite,
		CostMicros: model.CostMicros(u), CreatedAt: p.now(),
	}
	if !found {
		// Never undercharge silently: bill the worst-case estimate and flag it.
		rec.CostMicros, rec.Estimated = estimate, true
		p.cfg.Logger.Warn("no usage in response; charged estimate", "model", model.ID, "estimate_micros", estimate)
	}
	var err error
	if reservation != "" {
		err = p.ledger.Settle(ctx, reservation, rec)
	} else {
		err = p.ledger.RecordUsage(ctx, rec)
	}
	if err != nil {
		p.cfg.Logger.Error("record usage", "err", err, "model", model.ID)
	}
}
