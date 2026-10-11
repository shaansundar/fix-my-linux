package catalog

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"testing"

	"fixmylinux.app/server/internal/usage"
)

func load(t *testing.T) *Provider {
	t.Helper()
	srv := httptest.NewServer(http.FileServer(http.Dir("testdata")))
	t.Cleanup(srv.Close)
	p, err := HTTPFetcher(srv.Client(), srv.URL+"/api.json")(context.Background())
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	return p
}

func TestCostMicros(t *testing.T) {
	p := load(t)
	tests := []struct {
		name  string
		model string
		u     usage.Usage
		want  int64
	}{
		// 1000 input × $3 + 500 output × $15 = 3000 + 7500 µ$
		{"sonnet plain", "claude-sonnet-4-6", usage.Usage{Input: 1000, Output: 500}, 10_500},
		// cache read 10k × $0.30 + cache write 2k × $3.75 = 3000 + 7500
		{"sonnet cached", "claude-sonnet-4-6", usage.Usage{CacheRead: 10_000, CacheWrite: 2_000}, 10_500},
		{"gemini under 200k", "gemini-3.1-pro", usage.Usage{Input: 100_000, Output: 1_000}, 200_000 + 12_000},
		{"gemini over 200k uses the context tier", "gemini-3.1-pro", usage.Usage{Input: 250_000, Output: 1_000}, 1_000_000 + 18_000},
		{"cache write falls back to the input rate", "gpt-5.4-nano", usage.Usage{CacheWrite: 1_000_000}, 200_000},
		{"free model", "big-pickle", usage.Usage{Input: 1_000_000, Output: 1_000_000}, 0},
		{"rounds up fractions", "gpt-5.4-nano", usage.Usage{Input: 1}, 1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := p.Models[tt.model].CostMicros(tt.u); got != tt.want {
				t.Errorf("CostMicros = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestWorstCaseMicros(t *testing.T) {
	p := load(t)
	haiku := p.Models["claude-haiku-4-5"]
	// 10k prompt × $1 + 64k max output × $5
	if got := haiku.WorstCaseMicros(10_000, 0); got != 10_000+320_000 {
		t.Errorf("default max output: got %d", got)
	}
	if got := haiku.WorstCaseMicros(10_000, 1_000); got != 10_000+5_000 {
		t.Errorf("explicit max output: got %d", got)
	}
	if got := haiku.WorstCaseMicros(10_000, 10_000_000); got != 10_000+320_000 {
		t.Errorf("max output is capped at the model limit: got %d", got)
	}
}

func TestPlans(t *testing.T) {
	p := load(t)
	cfg := PlanConfig{
		PaidModels:     []string{"claude-haiku-4-5", "claude-sonnet-4-6", "not-in-catalog", "gpt-5.4-nano"},
		PaidDefault:    "claude-sonnet-4-6",
		PaidSmall:      "gpt-5.4-nano",
		FreePreference: []string{"nemotron-3-ultra-free"},
	}

	trial, err := p.PlanFor(PlanTrial, cfg)
	if err != nil {
		t.Fatal(err)
	}
	// Only active free models, preferred first; the deprecated glm-5-free is excluded.
	if want := []string{"nemotron-3-ultra-free", "big-pickle"}; !slices.Equal(trial.Allowed, want) {
		t.Errorf("trial allowed = %v, want %v", trial.Allowed, want)
	}
	if trial.DefaultModel != "nemotron-3-ultra-free" || trial.SmallModel != "nemotron-3-ultra-free" {
		t.Errorf("trial plan = %+v", trial)
	}

	paid, err := p.PlanFor(PlanPaid, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"claude-haiku-4-5", "claude-sonnet-4-6", "gpt-5.4-nano"}; !slices.Equal(paid.Allowed, want) {
		t.Errorf("paid allowed = %v, want %v", paid.Allowed, want)
	}
	if paid.DefaultModel != "claude-sonnet-4-6" || paid.SmallModel != "gpt-5.4-nano" {
		t.Errorf("paid plan = %+v", paid)
	}

	if _, err := p.PlanFor(PlanPaid, PlanConfig{}); err == nil {
		t.Error("expected an error for a paid plan with no models")
	}
}

func TestSubsetKeepsModelsDevShape(t *testing.T) {
	p := load(t)
	raw, err := p.Subset([]string{"big-pickle", "missing"})
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]json.RawMessage
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if string(out["id"]) != `"opencode"` || string(out["npm"]) != `"@ai-sdk/openai-compatible"` {
		t.Errorf("provider fields lost: id=%s npm=%s", out["id"], out["npm"])
	}
	var models map[string]map[string]any
	if err := json.Unmarshal(out["models"], &models); err != nil {
		t.Fatal(err)
	}
	if len(models) != 1 || models["big-pickle"]["limit"] == nil {
		t.Errorf("models = %v", models)
	}
}

func TestServiceKeepsLastGoodCatalog(t *testing.T) {
	good, err := os.ReadFile("testdata/api.json")
	if err != nil {
		t.Fatal(err)
	}
	fail := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if fail {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		_, _ = w.Write(good)
	}))
	defer srv.Close()

	s := NewService(HTTPFetcher(srv.Client(), srv.URL))
	if _, ok := s.Provider(); ok {
		t.Fatal("provider before first fetch")
	}
	if err := s.Refresh(context.Background()); err != nil {
		t.Fatal(err)
	}
	fail = true
	if err := s.Refresh(context.Background()); err == nil {
		t.Fatal("expected refresh error")
	}
	if p, ok := s.Provider(); !ok || len(p.Models) == 0 {
		t.Fatal("lost the cached catalog after a failed refresh")
	}
}
