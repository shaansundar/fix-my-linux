package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"fixmylinux.app/server/internal/store"
)

var secret = []byte("whsec_test")

func sign(body []byte) string {
	m := hmac.New(sha256.New, secret)
	m.Write(body)
	return hex.EncodeToString(m.Sum(nil))
}

func subEvent(event, id, userID, status, updated string, extra map[string]any) []byte {
	attrs := map[string]any{
		"status": status, "customer_id": 991, "created_at": "2026-10-01T09:00:00Z",
		"renews_at": "2026-11-01T09:00:00Z", "ends_at": nil, "updated_at": updated,
	}
	for k, v := range extra {
		attrs[k] = v
	}
	b, _ := json.Marshal(map[string]any{
		"meta": map[string]any{"event_name": event, "custom_data": map[string]string{"user_id": userID}},
		"data": map[string]any{"type": "subscriptions", "id": id, "attributes": attrs},
	})
	return b
}

func invoiceEvent(subID, created string) []byte {
	b, _ := json.Marshal(map[string]any{
		"meta": map[string]any{"event_name": "subscription_payment_success"},
		"data": map[string]any{"type": "subscription-invoices", "id": "inv_1", "attributes": map[string]any{
			"subscription_id": json.Number(subID), "status": "paid", "billing_reason": "renewal", "created_at": created,
		}},
	})
	return b
}

func setup(t *testing.T) (*Webhooks, *store.Memory, store.User) {
	t.Helper()
	mem := store.NewMemory()
	u, _ := mem.UpsertUser(context.Background(), "ana@example.com")
	return NewWebhooks(mem, secret, slog.New(slog.NewTextHandler(io.Discard, nil))), mem, u
}

func TestVerifySignature(t *testing.T) {
	body := []byte(`{"x":1}`)
	tests := []struct {
		name string
		sig  string
		ok   bool
	}{
		{"valid", sign(body), true},
		{"wrong", sign([]byte(`{"x":2}`)), false},
		{"not hex", "zz", false},
		{"empty", "", false},
	}
	for _, tt := range tests {
		if got := VerifySignature(secret, body, tt.sig); got != tt.ok {
			t.Errorf("%s: got %v", tt.name, got)
		}
	}
	if VerifySignature(nil, body, sign(body)) {
		t.Error("accepted with no secret configured")
	}
}

func TestSubscriptionLifecycle(t *testing.T) {
	ctx := context.Background()
	w, mem, u := setup(t)
	apply := func(body []byte) {
		t.Helper()
		if err := w.Handle(ctx, body, sign(body)); err != nil {
			t.Fatal(err)
		}
	}

	apply(subEvent("subscription_created", "123", u.ID, "active", "2026-10-01T09:00:01Z", nil))
	s, err := mem.SubscriptionFor(ctx, u.ID)
	if err != nil || s.Status != "active" || s.LSID != "123" || s.CustomerID != "991" {
		t.Fatalf("after created: %+v %v", s, err)
	}
	if !s.CurrentPeriodStart.Equal(time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC)) {
		t.Errorf("period start = %v", s.CurrentPeriodStart)
	}

	// Renewal: a paid invoice starts the next budget period.
	apply(invoiceEvent("123", "2026-11-01T09:00:05Z"))
	s, _ = mem.SubscriptionFor(ctx, u.ID)
	if !s.CurrentPeriodStart.Equal(time.Date(2026, 11, 1, 9, 0, 5, 0, time.UTC)) {
		t.Errorf("period after renewal = %v", s.CurrentPeriodStart)
	}

	// Cancelled; a later update event without custom data still finds the user.
	apply(subEvent("subscription_cancelled", "123", "", "cancelled", "2026-11-10T00:00:00Z", map[string]any{"ends_at": "2026-12-01T09:00:00Z"}))
	s, _ = mem.SubscriptionFor(ctx, u.ID)
	if s.Status != "cancelled" || s.EndsAt == nil || !s.CurrentPeriodStart.Equal(time.Date(2026, 11, 1, 9, 0, 5, 0, time.UTC)) {
		t.Errorf("after cancel: %+v", s)
	}
}

func TestOutOfOrderDeliveryCannotRegressState(t *testing.T) {
	ctx := context.Background()
	w, mem, u := setup(t)
	newer := subEvent("subscription_cancelled", "123", u.ID, "cancelled", "2026-11-10T00:00:00Z", nil)
	older := subEvent("subscription_updated", "123", u.ID, "active", "2026-11-09T00:00:00Z", nil)
	for _, b := range [][]byte{newer, older} {
		if err := w.Handle(ctx, b, sign(b)); err != nil {
			t.Fatal(err)
		}
	}
	if s, _ := mem.SubscriptionFor(ctx, u.ID); s.Status != "cancelled" {
		t.Fatalf("stale event won: %s", s.Status)
	}
}

func TestRejectsAndRetries(t *testing.T) {
	ctx := context.Background()
	w, mem, u := setup(t)
	body := subEvent("subscription_created", "123", u.ID, "active", "2026-10-01T09:00:01Z", nil)
	if err := w.Handle(ctx, body, "deadbeef"); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("bad signature err = %v", err)
	}
	unknown := subEvent("subscription_created", "456", "no-such-user", "active", "2026-10-01T09:00:01Z", nil)
	if err := w.Handle(ctx, unknown, sign(unknown)); err == nil {
		t.Fatal("expected an error for an unknown user")
	}
	// A failed event wasn't marked seen, so Lemon Squeezy's retry is applied.
	if first, _ := mem.FirstSeen(ctx, func() []byte { s := sha256.Sum256(unknown); return s[:] }()); !first {
		t.Error("failed event was recorded as seen")
	}
	other := []byte(`{"meta":{"event_name":"order_created"},"data":{"type":"orders","id":"1","attributes":{}}}`)
	if err := w.Handle(ctx, other, sign(other)); err != nil {
		t.Fatalf("unrelated event err = %v", err)
	}
}

func TestClient(t *testing.T) {
	var gotPath, gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth = r.Method+" "+r.URL.Path, r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		switch r.URL.Path {
		case "/v1/checkouts":
			_, _ = w.Write([]byte(`{"data":{"attributes":{"url":"https://fixmylinux.lemonsqueezy.com/checkout/custom/abc"}}}`))
		case "/v1/subscriptions/123":
			_, _ = w.Write([]byte(`{"data":{"attributes":{"urls":{"customer_portal":"https://fixmylinux.lemonsqueezy.com/billing?x=1"}}}}`))
		default:
			http.Error(w, `{"errors":[{"detail":"nope"}]}`, http.StatusNotFound)
		}
	}))
	defer srv.Close()
	ls := LemonSqueezy{APIKey: "key", StoreID: "1", VariantID: "2", RedirectURL: "https://fixmylinux.app/thanks", BaseURL: srv.URL}

	url, err := ls.CreateCheckout(context.Background(), store.User{ID: "u1", Email: "ana@example.com"})
	if err != nil || url != "https://fixmylinux.lemonsqueezy.com/checkout/custom/abc" {
		t.Fatalf("checkout = %q, %v", url, err)
	}
	if gotPath != "POST /v1/checkouts" || gotAuth != "Bearer key" {
		t.Errorf("request = %s %s", gotPath, gotAuth)
	}
	custom := gotBody["data"].(map[string]any)["attributes"].(map[string]any)["checkout_data"].(map[string]any)["custom"].(map[string]any)
	if custom["user_id"] != "u1" {
		t.Errorf("custom data = %v", custom)
	}

	portal, err := ls.PortalURL(context.Background(), "123")
	if err != nil || portal != "https://fixmylinux.lemonsqueezy.com/billing?x=1" {
		t.Fatalf("portal = %q, %v", portal, err)
	}
	if _, err := ls.PortalURL(context.Background(), "999"); err == nil {
		t.Error("expected error for missing subscription")
	}
}
