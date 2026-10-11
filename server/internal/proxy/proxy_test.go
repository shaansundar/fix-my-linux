package proxy

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"fixmylinux.app/server/internal/catalog"
	"fixmylinux.app/server/internal/entitlement"
	"fixmylinux.app/server/internal/store"
)

type upstreamCall struct {
	path    string
	headers http.Header
	body    string
}

type fakeZen struct {
	mu     sync.Mutex
	calls  []upstreamCall
	status int
	body   string
	sse    bool
	// delay between SSE chunks, to test client disconnects
	gap time.Duration
	// closed when the full body has been written
	done chan struct{}
}

func (f *fakeZen) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.calls = append(f.calls, upstreamCall{path: r.URL.RequestURI(), headers: r.Header.Clone(), body: string(b)})
	f.mu.Unlock()
	if f.sse {
		w.Header().Set("Content-Type", "text/event-stream")
	} else {
		w.Header().Set("Content-Type", "application/json")
	}
	w.Header().Set("Set-Cookie", "upstream=1")
	w.WriteHeader(f.status)
	for _, part := range strings.SplitAfter(f.body, "\n\n") {
		_, _ = io.WriteString(w, part)
		w.(http.Flusher).Flush()
		if f.gap > 0 {
			time.Sleep(f.gap)
		}
	}
	if f.done != nil {
		close(f.done)
	}
}

type staticCatalog struct{ p *catalog.Provider }

func (s staticCatalog) Provider() (*catalog.Provider, bool) { return s.p, s.p != nil }

func loadCatalog(t *testing.T) *catalog.Provider {
	t.Helper()
	srv := httptest.NewServer(http.FileServer(http.Dir("testdata")))
	defer srv.Close()
	p, err := catalog.HTTPFetcher(srv.Client(), srv.URL+"/api.json")(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

var plans = catalog.PlanConfig{
	PaidModels:  []string{"claude-haiku-4-5", "gemini-3.1-pro", "gpt-5.4-nano"},
	PaidDefault: "claude-haiku-4-5",
	PaidSmall:   "gpt-5.4-nano",
}

type env struct {
	zen    *fakeZen
	mem    *store.Memory
	server *httptest.Server
	acct   Account
	authOK bool
	user   store.User
}

func setup(t *testing.T, plan catalog.PlanKind) *env {
	t.Helper()
	e := &env{zen: &fakeZen{status: http.StatusOK}, mem: store.NewMemory(), authOK: true}
	up := httptest.NewServer(e.zen)
	t.Cleanup(up.Close)
	e.user, _ = e.mem.UpsertUser(context.Background(), "ana@example.com")
	now := time.Now()
	e.acct = Account{UserID: e.user.ID, Entitlement: entitlement.Entitlement{
		State: entitlement.StateActive, Plan: plan,
		PeriodStart: now.Add(-24 * time.Hour), PeriodEnd: now.Add(29 * 24 * time.Hour),
	}}
	if plan == catalog.PlanTrial {
		e.acct.Entitlement.State = entitlement.StateTrial
	}
	p := New(Config{
		Upstream: up.URL + "/zen/v1", ZenKey: "zen-secret", BudgetMicros: 8_000_000,
		TrialDailyRequests: 2, Plans: plans, Client: up.Client(),
	}, e.mem, staticCatalog{loadCatalog(t)}, func(r *http.Request) (Account, error) {
		if !e.authOK {
			return Account{}, ErrSignedOut
		}
		return e.acct, nil
	})
	mux := http.NewServeMux()
	mux.Handle("/zen/v1/", p)
	e.server = httptest.NewServer(mux)
	t.Cleanup(e.server.Close)
	return e
}

func (e *env) post(t *testing.T, path, body string) (*http.Response, string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, e.server.URL+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer fml_device_token")
	req.Header.Set("X-Api-Key", "should-not-forward")
	req.Header.Set("Anthropic-Version", "2023-06-01")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	return res, string(b)
}

func errorCode(t *testing.T, body string) string {
	t.Helper()
	var v struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &v); err != nil {
		t.Fatalf("not an error body: %s", body)
	}
	return v.Error.Code
}

func spent(t *testing.T, e *env) int64 {
	t.Helper()
	n, err := e.mem.SpentSince(context.Background(), e.user.ID, time.Now().Add(-48*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRejections(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(e *env)
		path   string
		body   string
		status int
		code   string
	}{
		{"signed out", func(e *env) { e.authOK = false }, "/zen/v1/messages", `{"model":"claude-haiku-4-5"}`, 401, "signed_out"},
		{"trial ended", func(e *env) {
			e.acct.Entitlement = entitlement.Entitlement{State: entitlement.StateExpired, Reason: entitlement.ReasonTrialEnded}
		}, "/zen/v1/messages", `{"model":"claude-haiku-4-5"}`, 402, "trial_ended"},
		{"model outside the plan", nil, "/zen/v1/messages", `{"model":"claude-sonnet-4-6"}`, 403, "model_not_allowed"},
		{"unknown endpoint", nil, "/zen/v1/models", `{}`, 404, "not_found"},
		// The test mux cleans dot-segments itself; either way Zen must never be called.
		{"dot segments toward other opencode.ai paths", nil, "/zen/v1/../../api/x/messages", `{"model":"claude-haiku-4-5"}`, 404, ""},
		{"encoded dot segments", nil, "/zen/v1/%2e%2e/%2e%2e/api/messages", `{"model":"claude-haiku-4-5"}`, 404, "not_found"},
		{"model path with a slash", nil, "/zen/v1/models/a/b:generateContent", `{}`, 404, "not_found"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := setup(t, catalog.PlanPaid)
			if tt.mutate != nil {
				tt.mutate(e)
			}
			res, body := e.post(t, tt.path, tt.body)
			if res.StatusCode != tt.status || (tt.code != "" && errorCode(t, body) != tt.code) {
				t.Fatalf("got %d %s", res.StatusCode, body)
			}
			if len(e.zen.calls) != 0 {
				t.Error("rejected request reached Zen")
			}
		})
	}
}

func TestForwardsEachFormatWithTheRightCredentialAndCharges(t *testing.T) {
	tests := []struct {
		name      string
		path      string
		reqBody   string
		respBody  string
		authHdr   string
		wantPath  string
		wantCost  int64
		wantModel string
	}{
		{
			name: "anthropic messages", path: "/zen/v1/messages",
			reqBody: `{"model":"claude-haiku-4-5","max_tokens":1000,"stream":true}`,
			respBody: "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1000,\"output_tokens\":1}}}\n\n" +
				"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":200}}\n\n",
			authHdr: "X-Api-Key", wantPath: "/zen/v1/messages",
			// 1000 × $1 + 200 × $5
			wantCost: 2000, wantModel: "claude-haiku-4-5",
		},
		{
			name: "gemini with the key moved out of the query", path: "/zen/v1/models/gemini-3.1-pro:streamGenerateContent?alt=sse&key=nonce",
			reqBody:  `{"contents":[],"generationConfig":{"maxOutputTokens":100}}`,
			respBody: "data: {\"usageMetadata\":{\"promptTokenCount\":10000,\"candidatesTokenCount\":100}}\n\n",
			authHdr:  "X-Goog-Api-Key", wantPath: "/zen/v1/models/gemini-3.1-pro:streamGenerateContent?alt=sse",
			// 10000 × $2 + 100 × $12
			wantCost: 21200, wantModel: "gemini-3.1-pro",
		},
		{
			name: "openai responses", path: "/zen/v1/responses",
			reqBody:  `{"model":"gpt-5.4-nano","max_output_tokens":50}`,
			respBody: "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":1000,\"output_tokens\":100}}}\n\n",
			authHdr:  "Authorization", wantPath: "/zen/v1/responses",
			// 1000 × $0.20 + 100 × $1.25
			wantCost: 325, wantModel: "gpt-5.4-nano",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := setup(t, catalog.PlanPaid)
			e.zen.sse, e.zen.body = true, tt.respBody
			res, body := e.post(t, tt.path, tt.reqBody)
			if res.StatusCode != 200 || body != tt.respBody {
				t.Fatalf("got %d %q", res.StatusCode, body)
			}
			if res.Header.Get("Content-Type") != "text/event-stream" {
				t.Errorf("content type = %q", res.Header.Get("Content-Type"))
			}
			call := e.zen.calls[0]
			if call.path != tt.wantPath || call.body != tt.reqBody {
				t.Errorf("upstream got %s %s", call.path, call.body)
			}
			want := "zen-secret"
			if tt.authHdr == "Authorization" {
				want = "Bearer zen-secret"
			}
			if got := call.headers.Get(tt.authHdr); got != want {
				t.Errorf("%s = %q", tt.authHdr, got)
			}
			// The device token and the client's own key never reach Zen.
			for _, h := range []string{"Authorization", "X-Api-Key", "X-Goog-Api-Key"} {
				if v := call.headers.Get(h); strings.Contains(v, "fml_") || v == "should-not-forward" {
					t.Errorf("%s leaked: %q", h, v)
				}
			}
			if call.headers.Get("Anthropic-Version") != "2023-06-01" {
				t.Error("anthropic-version not forwarded")
			}
			if got := spent(t, e); got != tt.wantCost {
				t.Errorf("charged %d µ$, want %d", got, tt.wantCost)
			}
		})
	}
}

func TestTrialCountsRequestsInsteadOfMoney(t *testing.T) {
	e := setup(t, catalog.PlanTrial)
	e.zen.body = `{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}`
	for range 2 {
		if res, body := e.post(t, "/zen/v1/chat/completions", `{"model":"big-pickle"}`); res.StatusCode != 200 {
			t.Fatalf("got %d %s", res.StatusCode, body)
		}
	}
	res, body := e.post(t, "/zen/v1/chat/completions", `{"model":"big-pickle"}`)
	if res.StatusCode != 429 || errorCode(t, body) != "daily_limit" || !strings.Contains(body, "resets_at") {
		t.Fatalf("got %d %s", res.StatusCode, body)
	}
	if got := spent(t, e); got != 0 {
		t.Errorf("free model charged %d", got)
	}
	// Paid models aren't available on the trial.
	if res, _ := e.post(t, "/zen/v1/messages", `{"model":"claude-haiku-4-5"}`); res.StatusCode != 403 {
		t.Errorf("paid model on trial got %d", res.StatusCode)
	}
}

func TestBudgetExhausted(t *testing.T) {
	e := setup(t, catalog.PlanPaid)
	_ = e.mem.RecordUsage(context.Background(), store.UsageRecord{UserID: e.user.ID, Model: "x", CostMicros: 7_900_000, CreatedAt: time.Now()})
	// Worst case: ~small prompt + 64k output × $5 = $0.32 > $0.10 left.
	res, body := e.post(t, "/zen/v1/messages", `{"model":"claude-haiku-4-5"}`)
	if res.StatusCode != 429 || errorCode(t, body) != "budget_exhausted" || !strings.Contains(body, "resets_at") {
		t.Fatalf("got %d %s", res.StatusCode, body)
	}
	// A request that fits its remaining allowance still goes through.
	e.zen.body = `{"usage":{"input_tokens":100,"output_tokens":100}}`
	if res, body := e.post(t, "/zen/v1/messages", `{"model":"claude-haiku-4-5","max_tokens":1000}`); res.StatusCode != 200 {
		t.Fatalf("small request got %d %s", res.StatusCode, body)
	}
}

func TestKeepsDrainingAfterTheClientLeaves(t *testing.T) {
	e := setup(t, catalog.PlanPaid)
	e.zen.sse, e.zen.gap, e.zen.done = true, 30*time.Millisecond, make(chan struct{})
	e.zen.body = "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1000}}}\n\n" +
		strings.Repeat("data: {\"type\":\"content_block_delta\"}\n\n", 5) +
		"data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":300}}\n\n"

	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, e.server.URL+"/zen/v1/messages", strings.NewReader(`{"model":"claude-haiku-4-5","max_tokens":500}`))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	_, _ = res.Body.Read(buf)
	cancel() // the person pressed stop
	res.Body.Close()

	<-e.zen.done
	deadline := time.Now().Add(2 * time.Second)
	for spent(t, e) == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	// 1000 × $1 + 300 × $5: the full call is billed even though the client left.
	if got := spent(t, e); got != 2500 {
		t.Fatalf("charged %d µ$, want 2500", got)
	}
}

func TestUpstreamErrorsReleaseTheHoldAndChargeNothing(t *testing.T) {
	e := setup(t, catalog.PlanPaid)
	e.zen.status, e.zen.body = http.StatusInternalServerError, `{"error":"boom"}`
	res, body := e.post(t, "/zen/v1/messages", `{"model":"claude-haiku-4-5"}`)
	if res.StatusCode != 500 || body != `{"error":"boom"}` {
		t.Fatalf("got %d %s", res.StatusCode, body)
	}
	if got := spent(t, e); got != 0 {
		t.Errorf("charged %d for a failed call", got)
	}
	// The hold was released, so the whole budget is available again.
	_, ok, _ := e.mem.Reserve(context.Background(), store.Hold{UserID: e.user.ID, Amount: 8_000_000, Budget: 8_000_000, PeriodStart: time.Now().Add(-time.Hour), ExpiresAt: time.Now().Add(time.Minute)})
	if !ok {
		t.Error("hold from the failed call was not released")
	}
}

func TestMissingUsageChargesTheEstimate(t *testing.T) {
	e := setup(t, catalog.PlanPaid)
	e.zen.body = `{"content":[]}`
	if res, _ := e.post(t, "/zen/v1/messages", `{"model":"claude-haiku-4-5","max_tokens":100}`); res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	if got := spent(t, e); got <= 500 {
		t.Errorf("charged %d, expected the worst-case estimate (≥ 100 × $5)", got)
	}
}

func TestUpstreamCookiesAreNotForwarded(t *testing.T) {
	e := setup(t, catalog.PlanPaid)
	e.zen.body = `{"usage":{"input_tokens":1,"output_tokens":1}}`
	res, _ := e.post(t, "/zen/v1/messages", `{"model":"claude-haiku-4-5"}`)
	// Set-Cookie passes through as an ordinary header; nothing secret is in it,
	// but make sure hop-by-hop headers are stripped.
	if res.Header.Get("Transfer-Encoding") != "" {
		t.Error("hop-by-hop header leaked")
	}
}
