package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"fixmylinux.app/server/internal/catalog"
	"fixmylinux.app/server/internal/config"
	"fixmylinux.app/server/internal/store"
)

type inbox struct {
	mu    sync.Mutex
	codes map[string]string
}

func (i *inbox) SendCode(_ context.Context, to, code string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.codes[to] = code
	return nil
}

type fakeBilling struct{}

func (fakeBilling) CreateCheckout(_ context.Context, u store.User) (string, error) {
	return "https://fixmylinux.lemonsqueezy.com/checkout/" + u.ID, nil
}
func (fakeBilling) PortalURL(_ context.Context, id string) (string, error) {
	return "https://fixmylinux.lemonsqueezy.com/billing/" + id, nil
}

type world struct {
	t      *testing.T
	srv    *httptest.Server
	inbox  *inbox
	now    time.Time
	mu     sync.Mutex
	secret []byte
}

func (w *world) clock() time.Time {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.now
}

func (w *world) advance(d time.Duration) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.now = w.now.Add(d)
}

func newWorld(t *testing.T) *world {
	t.Helper()
	zen := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/messages") {
			_, _ = io.WriteString(rw, `{"usage":{"input_tokens":1000,"output_tokens":100}}`)
			return
		}
		_, _ = io.WriteString(rw, `{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}`)
	}))
	t.Cleanup(zen.Close)
	raw, err := os.ReadFile("testdata/api.json")
	if err != nil {
		t.Fatal(err)
	}
	cat := httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) { _, _ = rw.Write(raw) }))
	t.Cleanup(cat.Close)

	w := &world{t: t, inbox: &inbox{codes: map[string]string{}}, now: time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC), secret: []byte("whsec")}
	mem := store.NewMemory()
	mem.Now = w.clock
	cfg, err := config.Load(func(k string) string {
		return map[string]string{
			"FML_DEV_MEMORY": "1", "ZEN_API_KEY": "zen", "ZEN_BASE_URL": zen.URL + "/zen/v1",
			"CODE_SECRET": strings.Repeat("c", 32), "MACHINE_HMAC_SECRET": strings.Repeat("m", 32),
			"LEMONSQUEEZY_WEBHOOK_SECRET": "whsec", "PAID_MODELS": "claude-haiku-4-5,gpt-5.4-nano",
		}[k]
	})
	if err != nil {
		t.Fatal(err)
	}
	a, err := BuildWith(context.Background(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), Options{
		Store: mem, Mailer: w.inbox, Billing: fakeBilling{}, Now: w.clock,
		Fetcher: catalog.HTTPFetcher(cat.Client(), cat.URL),
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	w.srv = httptest.NewServer(a.Handler)
	t.Cleanup(w.srv.Close)
	return w
}

func (w *world) call(method, path, token string, body any, headers ...string) (int, map[string]any) {
	w.t.Helper()
	var r io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		r = bytes.NewReader(b)
	default:
		enc, _ := json.Marshal(b)
		r = bytes.NewReader(enc)
	}
	req, _ := http.NewRequest(method, w.srv.URL+path, r)
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	for i := 0; i+1 < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		w.t.Fatal(err)
	}
	defer res.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func (w *world) signIn(email, machine string) (string, map[string]any) {
	w.t.Helper()
	if code, _ := w.call("POST", "/v1/auth/otp/start", "", map[string]string{"email": email}); code != 204 {
		w.t.Fatalf("otp start = %d", code)
	}
	code, out := w.call("POST", "/v1/auth/otp/verify", "", map[string]string{"email": email, "code": w.inbox.codes[email], "machine_id": machine})
	if code != 200 {
		w.t.Fatalf("verify = %d %v", code, out)
	}
	return out["token"].(string), out["account"].(map[string]any)
}

func errCode(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	s, _ := e["code"].(string)
	return s
}

func TestAccountLifecycle(t *testing.T) {
	w := newWorld(t)
	token, acct := w.signIn("ana@example.com", "machine-1")
	if acct["state"] != "trial" || acct["daily_limit"].(float64) != 300 {
		t.Fatalf("account after sign-in = %v", acct)
	}

	// The trial catalog holds only free models.
	code, cat := w.call("GET", "/v1/catalog", token, nil)
	if code != 200 {
		t.Fatalf("catalog = %d", code)
	}
	plan := cat["plan"].(map[string]any)
	if plan["defaultModel"] != "big-pickle" {
		t.Errorf("trial plan = %v", plan)
	}
	if _, ok := cat["provider"].(map[string]any)["models"].(map[string]any)["claude-haiku-4-5"]; ok {
		t.Error("paid model in the trial catalog")
	}

	// A free model call goes through and counts toward today's limit.
	if code, out := w.call("POST", "/zen/v1/chat/completions", token, map[string]string{"model": "big-pickle"}); code != 200 {
		t.Fatalf("trial call = %d %v", code, out)
	}
	if _, me := w.call("GET", "/v1/me", token, nil); me["used_today"].(float64) != 1 {
		t.Errorf("me = %v", me)
	}

	// After five days the trial ends.
	w.advance(6 * 24 * time.Hour)
	if _, me := w.call("GET", "/v1/me", token, nil); me["state"] != "expired" || me["reason"] != "trial_ended" {
		t.Fatalf("me after trial = %v", me)
	}
	if code, out := w.call("POST", "/zen/v1/chat/completions", token, map[string]string{"model": "big-pickle"}); code != 402 || errCode(out) != "trial_ended" {
		t.Fatalf("call after trial = %d %v", code, out)
	}
	if code, out := w.call("POST", "/v1/billing/checkout", token, nil); code != 200 || !strings.Contains(out["url"].(string), "/checkout/") {
		t.Fatalf("checkout = %d %v", code, out)
	}
	if code, out := w.call("GET", "/v1/billing/portal", token, nil); code != 404 || errCode(out) != "no_subscription" {
		t.Fatalf("portal before subscribing = %d %v", code, out)
	}

	// Lemon Squeezy confirms the subscription.
	_, me := w.call("GET", "/v1/me", token, nil)
	userID := lookupUser(t, w, token)
	body, _ := json.Marshal(map[string]any{
		"meta": map[string]any{"event_name": "subscription_created", "custom_data": map[string]string{"user_id": userID}},
		"data": map[string]any{"type": "subscriptions", "id": "sub_1", "attributes": map[string]any{
			"status": "active", "customer_id": 7, "created_at": w.clock().Format(time.RFC3339),
			"renews_at": w.clock().AddDate(0, 1, 0).Format(time.RFC3339), "updated_at": w.clock().Format(time.RFC3339),
		}},
	})
	m := hmac.New(sha256.New, w.secret)
	m.Write(body)
	if code, _ := w.call("POST", "/v1/webhooks/lemonsqueezy", "", body, "X-Signature", "bad"); code != 401 {
		t.Fatalf("unsigned webhook = %d", code)
	}
	if code, out := w.call("POST", "/v1/webhooks/lemonsqueezy", "", body, "X-Signature", hex.EncodeToString(m.Sum(nil))); code != 204 {
		t.Fatalf("webhook = %d %v", code, out)
	}
	_ = me

	_, me = w.call("GET", "/v1/me", token, nil)
	if me["state"] != "active" || me["budget_usd"].(float64) != 8 {
		t.Fatalf("me after subscribing = %v", me)
	}
	_, cat = w.call("GET", "/v1/catalog", token, nil)
	if cat["plan"].(map[string]any)["defaultModel"] != "claude-haiku-4-5" {
		t.Errorf("paid plan = %v", cat["plan"])
	}

	// Paid usage is metered: 1000 × $1 + 100 × $5 = $0.0015.
	if code, out := w.call("POST", "/zen/v1/messages", token, map[string]any{"model": "claude-haiku-4-5", "max_tokens": 200}); code != 200 {
		t.Fatalf("paid call = %d %v", code, out)
	}
	_, me = w.call("GET", "/v1/me", token, nil)
	if got := me["used_usd"].(float64); got < 0.0014 || got > 0.0016 {
		t.Errorf("used_usd = %v", got)
	}
	if code, out := w.call("GET", "/v1/billing/portal", token, nil); code != 200 || !strings.HasSuffix(out["url"].(string), "/sub_1") {
		t.Fatalf("portal = %d %v", code, out)
	}

	// Signing out revokes the token everywhere.
	if code, _ := w.call("POST", "/v1/auth/signout", token, nil); code != 204 {
		t.Fatal("sign out failed")
	}
	if code, _ := w.call("GET", "/v1/me", token, nil); code != 401 {
		t.Fatal("token still works after sign-out")
	}
	if code, out := w.call("POST", "/zen/v1/messages", token, map[string]any{"model": "claude-haiku-4-5"}); code != 401 || errCode(out) != "signed_out" {
		t.Fatalf("proxy after sign-out = %d %v", code, out)
	}
}

func lookupUser(t *testing.T, w *world, token string) string {
	t.Helper()
	// The account API doesn't expose ids; checkout embeds it in the fake URL.
	_, out := w.call("POST", "/v1/billing/checkout", token, nil)
	url := out["url"].(string)
	return url[strings.LastIndex(url, "/")+1:]
}

func TestSecondAccountOnTheSameComputerGetsNoTrial(t *testing.T) {
	w := newWorld(t)
	w.signIn("ana@example.com", "machine-1")
	token, acct := w.signIn("ana.again@example.com", "machine-1")
	if acct["state"] != "expired" || acct["reason"] != "trial_unavailable" {
		t.Fatalf("account = %v", acct)
	}
	if code, out := w.call("POST", "/zen/v1/chat/completions", token, map[string]string{"model": "big-pickle"}); code != 402 || errCode(out) != "trial_unavailable" {
		t.Fatalf("call = %d %v", code, out)
	}
}

func TestAPIErrors(t *testing.T) {
	w := newWorld(t)
	tests := []struct {
		name   string
		method string
		path   string
		body   any
		status int
		code   string
	}{
		{"bad email", "POST", "/v1/auth/otp/start", map[string]string{"email": "nope"}, 400, "invalid_email"},
		{"unknown field", "POST", "/v1/auth/otp/start", map[string]string{"email": "a@b.co", "x": "y"}, 400, "bad_request"},
		{"wrong code", "POST", "/v1/auth/otp/verify", map[string]string{"email": "a@b.co", "code": "000000", "machine_id": "m"}, 400, "invalid_code"},
		{"me without token", "GET", "/v1/me", nil, 401, "signed_out"},
		{"proxy without token", "POST", "/zen/v1/messages", map[string]string{"model": "x"}, 401, "signed_out"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			code, out := w.call(tt.method, tt.path, "", tt.body)
			if code != tt.status || errCode(out) != tt.code {
				t.Fatalf("got %d %v", code, out)
			}
		})
	}
	if code, out := w.call("GET", "/healthz", "", nil); code != 200 || out["status"] != "ok" {
		t.Fatalf("health = %d %v", code, out)
	}
}

func TestSignInRateLimit(t *testing.T) {
	w := newWorld(t)
	limited := false
	for i := range 15 {
		code, _ := w.call("POST", "/v1/auth/otp/verify", "", map[string]string{"email": "a@b.co", "code": "000000", "machine_id": "m"}, "X-Forwarded-For", "203.0.113.9")
		if code == 429 {
			limited = i >= 10
			break
		}
	}
	if !limited {
		t.Fatal("sign-in attempts from one address were not rate limited after the burst")
	}
}
