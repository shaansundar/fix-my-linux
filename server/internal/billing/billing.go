// Package billing talks to Lemon Squeezy: it creates checkouts, finds the
// customer portal, and applies signed webhooks to subscription state.
package billing

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"fixmylinux.app/server/internal/store"
)

// LemonSqueezy is the API client.
type LemonSqueezy struct {
	APIKey    string
	StoreID   string
	VariantID string
	// Where the browser lands after paying.
	RedirectURL string
	BaseURL     string
	Client      *http.Client
}

func (l LemonSqueezy) base() string {
	if l.BaseURL != "" {
		return l.BaseURL
	}
	return "https://api.lemonsqueezy.com"
}

func (l LemonSqueezy) do(ctx context.Context, method, path string, body any, out any) error {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("failed to encode request: %w", err)
		}
		r = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, l.base()+path, r)
	if err != nil {
		return fmt.Errorf("failed to build request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.api+json")
	req.Header.Set("Content-Type", "application/vnd.api+json")
	req.Header.Set("Authorization", "Bearer "+l.APIKey)
	client := l.Client
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to reach Lemon Squeezy: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(res.Body, 2048))
		return fmt.Errorf("lemon squeezy %s %s: status %d: %s", method, path, res.StatusCode, detail)
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}
	return nil
}

// CreateCheckout returns a hosted checkout URL tied to the account.
func (l LemonSqueezy) CreateCheckout(ctx context.Context, user store.User) (string, error) {
	body := map[string]any{
		"data": map[string]any{
			"type": "checkouts",
			"attributes": map[string]any{
				"checkout_data": map[string]any{
					"email":  user.Email,
					"custom": map[string]string{"user_id": user.ID},
				},
				"product_options": map[string]any{
					"redirect_url":     l.RedirectURL,
					"receipt_link_url": l.RedirectURL,
				},
				"checkout_options": map[string]any{"embed": false},
			},
			"relationships": map[string]any{
				"store":   map[string]any{"data": map[string]string{"type": "stores", "id": l.StoreID}},
				"variant": map[string]any{"data": map[string]string{"type": "variants", "id": l.VariantID}},
			},
		},
	}
	var out struct {
		Data struct {
			Attributes struct {
				URL string `json:"url"`
			} `json:"attributes"`
		} `json:"data"`
	}
	if err := l.do(ctx, http.MethodPost, "/v1/checkouts", body, &out); err != nil {
		return "", fmt.Errorf("failed to create checkout: %w", err)
	}
	if out.Data.Attributes.URL == "" {
		return "", errors.New("checkout has no url")
	}
	return out.Data.Attributes.URL, nil
}

// PortalURL is the signed customer-portal link for a subscription.
func (l LemonSqueezy) PortalURL(ctx context.Context, subscriptionID string) (string, error) {
	var out struct {
		Data struct {
			Attributes struct {
				URLs struct {
					CustomerPortal string `json:"customer_portal"`
				} `json:"urls"`
			} `json:"attributes"`
		} `json:"data"`
	}
	if err := l.do(ctx, http.MethodGet, "/v1/subscriptions/"+subscriptionID, nil, &out); err != nil {
		return "", fmt.Errorf("failed to load subscription: %w", err)
	}
	if out.Data.Attributes.URLs.CustomerPortal == "" {
		return "", errors.New("subscription has no portal url")
	}
	return out.Data.Attributes.URLs.CustomerPortal, nil
}

// VerifySignature checks Lemon Squeezy's X-Signature (hex HMAC-SHA256 of the raw body).
func VerifySignature(secret, body []byte, signature string) bool {
	want, err := hex.DecodeString(signature)
	if err != nil || len(secret) == 0 {
		return false
	}
	m := hmac.New(sha256.New, secret)
	m.Write(body)
	return hmac.Equal(m.Sum(nil), want)
}

// Store is the persistence webhooks need.
type Store interface {
	UpsertSubscription(ctx context.Context, s store.Subscription) error
	SubscriptionByLSID(ctx context.Context, lsID string) (store.Subscription, error)
	SetPeriodStart(ctx context.Context, lsID string, t time.Time) error
	FirstSeen(ctx context.Context, bodyHash []byte) (bool, error)
	UserByID(ctx context.Context, id string) (store.User, error)
}

var ErrBadSignature = errors.New("bad webhook signature")

type Webhooks struct {
	store  Store
	secret []byte
	logger *slog.Logger
}

func NewWebhooks(st Store, secret []byte, logger *slog.Logger) *Webhooks {
	return &Webhooks{store: st, secret: secret, logger: logger}
}

type webhook struct {
	Meta struct {
		EventName  string            `json:"event_name"`
		CustomData map[string]string `json:"custom_data"`
	} `json:"meta"`
	Data struct {
		Type       string          `json:"type"`
		ID         string          `json:"id"`
		Attributes json.RawMessage `json:"attributes"`
	} `json:"data"`
}

type subscriptionAttrs struct {
	Status     string      `json:"status"`
	CustomerID json.Number `json:"customer_id"`
	RenewsAt   *time.Time  `json:"renews_at"`
	EndsAt     *time.Time  `json:"ends_at"`
	CreatedAt  time.Time   `json:"created_at"`
	UpdatedAt  *time.Time  `json:"updated_at"`
}

type invoiceAttrs struct {
	SubscriptionID json.Number `json:"subscription_id"`
	Status         string      `json:"status"`
	CreatedAt      time.Time   `json:"created_at"`
}

// Handle verifies and applies one webhook. Applying is idempotent and ordered
// by Lemon Squeezy's updated_at, so retries and out-of-order deliveries are safe;
// an event is recorded as seen only once it has been applied.
func (w *Webhooks) Handle(ctx context.Context, body []byte, signature string) error {
	if !VerifySignature(w.secret, body, signature) {
		return ErrBadSignature
	}
	var hook webhook
	if err := json.Unmarshal(body, &hook); err != nil {
		return fmt.Errorf("failed to parse webhook: %w", err)
	}
	switch hook.Meta.EventName {
	case "subscription_created", "subscription_updated", "subscription_cancelled", "subscription_resumed",
		"subscription_expired", "subscription_paused", "subscription_unpaused", "subscription_payment_success",
		"subscription_payment_failed", "subscription_payment_recovered":
	default:
		w.logger.Info("ignoring webhook", "event", hook.Meta.EventName)
		return nil
	}

	var err error
	if hook.Data.Type == "subscription-invoices" {
		err = w.invoice(ctx, hook)
	} else {
		err = w.subscription(ctx, hook)
	}
	if err != nil {
		return err
	}
	sum := sha256.Sum256(body)
	if _, err := w.store.FirstSeen(ctx, sum[:]); err != nil {
		w.logger.Warn("failed to record webhook", "err", err)
	}
	return nil
}

func (w *Webhooks) subscription(ctx context.Context, hook webhook) error {
	var a subscriptionAttrs
	if err := json.Unmarshal(hook.Data.Attributes, &a); err != nil {
		return fmt.Errorf("failed to parse subscription: %w", err)
	}
	userID := hook.Meta.CustomData["user_id"]
	existing, err := w.store.SubscriptionByLSID(ctx, hook.Data.ID)
	switch {
	case err == nil:
		userID = existing.UserID
	case errors.Is(err, store.ErrNotFound):
		if userID == "" {
			return fmt.Errorf("subscription %s has no user", hook.Data.ID)
		}
		if _, err := w.store.UserByID(ctx, userID); err != nil {
			return fmt.Errorf("subscription %s names unknown user %s: %w", hook.Data.ID, userID, err)
		}
	default:
		return fmt.Errorf("failed to load subscription: %w", err)
	}
	s := store.Subscription{
		LSID: hook.Data.ID, UserID: userID, Status: a.Status, CustomerID: a.CustomerID.String(),
		RenewsAt: a.RenewsAt, EndsAt: a.EndsAt, LSUpdatedAt: a.UpdatedAt,
	}
	if errors.Is(err, store.ErrNotFound) {
		s.CurrentPeriodStart = a.CreatedAt
	}
	if err := w.store.UpsertSubscription(ctx, s); err != nil {
		return fmt.Errorf("failed to save subscription: %w", err)
	}
	w.logger.Info("subscription updated", "event", hook.Meta.EventName, "subscription", hook.Data.ID, "status", a.Status)
	return nil
}

// A paid renewal invoice starts a new budget period.
func (w *Webhooks) invoice(ctx context.Context, hook webhook) error {
	var a invoiceAttrs
	if err := json.Unmarshal(hook.Data.Attributes, &a); err != nil {
		return fmt.Errorf("failed to parse invoice: %w", err)
	}
	if hook.Meta.EventName != "subscription_payment_success" || a.Status != "paid" {
		return nil
	}
	err := w.store.SetPeriodStart(ctx, a.SubscriptionID.String(), a.CreatedAt)
	if errors.Is(err, store.ErrNotFound) {
		// The subscription webhook hasn't arrived yet; it sets the period from created_at.
		w.logger.Warn("payment for unknown subscription", "subscription", a.SubscriptionID.String())
		return nil
	}
	if err != nil {
		return fmt.Errorf("failed to start billing period: %w", err)
	}
	return nil
}
