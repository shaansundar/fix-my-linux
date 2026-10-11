package store

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"
)

// full is everything both implementations provide.
type full interface {
	CreateOTP(context.Context, string, []byte, time.Time) error
	LatestOTP(context.Context, string) (OTP, error)
	BumpOTPAttempts(context.Context, int64) (int, error)
	ConsumeOTP(context.Context, int64) error
	CountOTPsSince(context.Context, string, time.Time) (int, error)
	UpsertUser(context.Context, string) (User, error)
	UserByID(context.Context, string) (User, error)
	CreateDevice(context.Context, string, []byte, []byte) (Device, error)
	DeviceByToken(context.Context, []byte) (Device, User, error)
	RevokeDevice(context.Context, []byte) error
	StartTrial(context.Context, string, []byte, time.Time, time.Duration) (Trial, error)
	TrialFor(context.Context, string) (Trial, error)
	UpsertSubscription(context.Context, Subscription) error
	SubscriptionFor(context.Context, string) (Subscription, error)
	SubscriptionByLSID(context.Context, string) (Subscription, error)
	SetPeriodStart(context.Context, string, time.Time) error
	Reserve(context.Context, Hold) (string, bool, error)
	Settle(context.Context, string, UsageRecord) error
	Release(context.Context, string) error
	RecordUsage(context.Context, UsageRecord) error
	SpentSince(context.Context, string, time.Time) (int64, error)
	RequestsSince(context.Context, string, time.Time) (int, error)
	FirstSeen(context.Context, []byte) (bool, error)
}

var (
	_ full = (*Memory)(nil)
	_ full = (*Postgres)(nil)
)

func stores(t *testing.T) map[string]func(t *testing.T) full {
	out := map[string]func(t *testing.T) full{
		"memory": func(t *testing.T) full { return NewMemory() },
	}
	url := os.Getenv("FML_TEST_DATABASE_URL")
	if url == "" {
		return out
	}
	pg, err := Open(context.Background(), url)
	if err != nil {
		t.Fatalf("open postgres: %v", err)
	}
	t.Cleanup(pg.Close)
	out["postgres"] = func(t *testing.T) full {
		if err := pg.Reset(context.Background()); err != nil {
			t.Fatal(err)
		}
		return pg
	}
	return out
}

func TestStore(t *testing.T) {
	ctx := context.Background()
	for name, mk := range stores(t) {
		t.Run(name, func(t *testing.T) {
			t.Run("otp lifecycle", func(t *testing.T) {
				s := mk(t)
				exp := time.Now().Add(10 * time.Minute)
				if err := s.CreateOTP(ctx, "ana@example.com", []byte("h1"), exp); err != nil {
					t.Fatal(err)
				}
				if err := s.CreateOTP(ctx, "ana@example.com", []byte("h2"), exp); err != nil {
					t.Fatal(err)
				}
				o, err := s.LatestOTP(ctx, "ana@example.com")
				if err != nil || string(o.CodeHash) != "h2" {
					t.Fatalf("latest = %+v, %v", o, err)
				}
				if n, _ := s.BumpOTPAttempts(ctx, o.ID); n != 1 {
					t.Errorf("attempts = %d", n)
				}
				if err := s.ConsumeOTP(ctx, o.ID); err != nil {
					t.Fatal(err)
				}
				if o, _ = s.LatestOTP(ctx, "ana@example.com"); o.ConsumedAt == nil {
					t.Error("not consumed")
				}
				if n, _ := s.CountOTPsSince(ctx, "ana@example.com", time.Now().Add(-time.Hour)); n != 2 {
					t.Errorf("count = %d", n)
				}
				if _, err := s.LatestOTP(ctx, "nobody@example.com"); !errors.Is(err, ErrNotFound) {
					t.Errorf("missing otp err = %v", err)
				}
			})

			t.Run("users and devices", func(t *testing.T) {
				s := mk(t)
				u1, _ := s.UpsertUser(ctx, "ana@example.com")
				u2, _ := s.UpsertUser(ctx, "ana@example.com")
				if u1.ID == "" || u1.ID != u2.ID {
					t.Fatalf("upsert not idempotent: %v %v", u1, u2)
				}
				if _, err := s.CreateDevice(ctx, u1.ID, []byte("tok"), []byte("m1")); err != nil {
					t.Fatal(err)
				}
				d, u, err := s.DeviceByToken(ctx, []byte("tok"))
				if err != nil || d.UserID != u1.ID || u.Email != "ana@example.com" {
					t.Fatalf("device lookup = %+v %+v %v", d, u, err)
				}
				if err := s.RevokeDevice(ctx, []byte("tok")); err != nil {
					t.Fatal(err)
				}
				if _, _, err := s.DeviceByToken(ctx, []byte("tok")); !errors.Is(err, ErrNotFound) {
					t.Errorf("revoked device still works: %v", err)
				}
			})

			t.Run("one trial per account and per machine", func(t *testing.T) {
				s := mk(t)
				ana, _ := s.UpsertUser(ctx, "ana@example.com")
				bob, _ := s.UpsertUser(ctx, "bob@example.com")
				start := time.Now().UTC().Truncate(time.Second)
				tr, err := s.StartTrial(ctx, ana.ID, []byte("m1"), start, 5*24*time.Hour)
				if err != nil || !tr.EndsAt.Equal(start.Add(5*24*time.Hour)) {
					t.Fatalf("trial = %+v, %v", tr, err)
				}
				// Signing in again keeps the original trial.
				again, err := s.StartTrial(ctx, ana.ID, []byte("m2"), start.Add(time.Hour), 5*24*time.Hour)
				if err != nil || !again.StartedAt.Equal(start) {
					t.Fatalf("second start = %+v, %v", again, err)
				}
				if _, err := s.StartTrial(ctx, bob.ID, []byte("m1"), start, 5*24*time.Hour); !errors.Is(err, ErrTrialUsed) {
					t.Errorf("machine reuse err = %v", err)
				}
				if _, err := s.TrialFor(ctx, bob.ID); !errors.Is(err, ErrNotFound) {
					t.Errorf("bob trial err = %v", err)
				}
			})

			t.Run("subscriptions keep their billing period across updates", func(t *testing.T) {
				s := mk(t)
				u, _ := s.UpsertUser(ctx, "ana@example.com")
				p1 := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
				renews := p1.AddDate(0, 1, 0)
				if err := s.UpsertSubscription(ctx, Subscription{LSID: "sub_1", UserID: u.ID, Status: "active", RenewsAt: &renews, CurrentPeriodStart: p1}); err != nil {
					t.Fatal(err)
				}
				if err := s.UpsertSubscription(ctx, Subscription{LSID: "sub_1", UserID: u.ID, Status: "cancelled", RenewsAt: &renews}); err != nil {
					t.Fatal(err)
				}
				got, err := s.SubscriptionFor(ctx, u.ID)
				if err != nil || got.Status != "cancelled" || !got.CurrentPeriodStart.Equal(p1) {
					t.Fatalf("subscription = %+v, %v", got, err)
				}
				p2 := p1.AddDate(0, 1, 0)
				if err := s.SetPeriodStart(ctx, "sub_1", p2); err != nil {
					t.Fatal(err)
				}
				if got, _ = s.SubscriptionByLSID(ctx, "sub_1"); !got.CurrentPeriodStart.Equal(p2) {
					t.Errorf("period start = %v", got.CurrentPeriodStart)
				}
				if err := s.SetPeriodStart(ctx, "nope", p2); !errors.Is(err, ErrNotFound) {
					t.Errorf("missing sub err = %v", err)
				}
			})

			t.Run("an older lemon squeezy update never overwrites a newer one", func(t *testing.T) {
				s := mk(t)
				u, _ := s.UpsertUser(ctx, "ana@example.com")
				newer := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
				older := newer.Add(-time.Hour)
				p := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
				_ = s.UpsertSubscription(ctx, Subscription{LSID: "sub_9", UserID: u.ID, Status: "cancelled", CurrentPeriodStart: p, LSUpdatedAt: &newer})
				_ = s.UpsertSubscription(ctx, Subscription{LSID: "sub_9", UserID: u.ID, Status: "active", LSUpdatedAt: &older})
				if got, _ := s.SubscriptionByLSID(ctx, "sub_9"); got.Status != "cancelled" {
					t.Fatalf("status = %s", got.Status)
				}
			})

			t.Run("reservations never let spend exceed the budget", func(t *testing.T) {
				s := mk(t)
				u, _ := s.UpsertUser(ctx, "ana@example.com")
				period := time.Now().Add(-24 * time.Hour)
				hold := func(amount int64) (string, bool) {
					id, ok, err := s.Reserve(ctx, Hold{UserID: u.ID, Amount: amount, Budget: 1000, PeriodStart: period, ExpiresAt: time.Now().Add(time.Minute)})
					if err != nil {
						t.Fatal(err)
					}
					return id, ok
				}
				_ = s.RecordUsage(ctx, UsageRecord{UserID: u.ID, Model: "m", CostMicros: 400, CreatedAt: time.Now()})
				// Usage before the period doesn't count.
				_ = s.RecordUsage(ctx, UsageRecord{UserID: u.ID, Model: "m", CostMicros: 900, CreatedAt: period.Add(-time.Hour)})

				a, ok := hold(500)
				if !ok {
					t.Fatal("first hold refused")
				}
				if _, ok := hold(200); ok {
					t.Fatal("hold accepted beyond budget (400 spent + 500 held + 200)")
				}
				if err := s.Settle(ctx, a, UsageRecord{UserID: u.ID, Model: "m", CostMicros: 100, CreatedAt: time.Now()}); err != nil {
					t.Fatal(err)
				}
				if spent, _ := s.SpentSince(ctx, u.ID, period); spent != 500 {
					t.Errorf("spent = %d", spent)
				}
				if _, ok := hold(500); !ok {
					t.Error("hold refused after settling released the reservation")
				}
				if n, _ := s.RequestsSince(ctx, u.ID, period); n != 2 {
					t.Errorf("requests = %d", n)
				}
			})

			t.Run("concurrent holds are serialized", func(t *testing.T) {
				s := mk(t)
				u, _ := s.UpsertUser(ctx, "ana@example.com")
				var wg sync.WaitGroup
				var mu sync.Mutex
				accepted := 0
				for range 20 {
					wg.Add(1)
					go func() {
						defer wg.Done()
						_, ok, err := s.Reserve(ctx, Hold{UserID: u.ID, Amount: 100, Budget: 1000, PeriodStart: time.Now().Add(-time.Hour), ExpiresAt: time.Now().Add(time.Minute)})
						if err != nil {
							t.Error(err)
							return
						}
						if ok {
							mu.Lock()
							accepted++
							mu.Unlock()
						}
					}()
				}
				wg.Wait()
				if accepted != 10 {
					t.Errorf("accepted %d holds of 100 against a budget of 1000", accepted)
				}
			})

			t.Run("webhook bodies are processed once", func(t *testing.T) {
				s := mk(t)
				first, _ := s.FirstSeen(ctx, []byte("abc"))
				second, _ := s.FirstSeen(ctx, []byte("abc"))
				if !first || second {
					t.Errorf("first=%v second=%v", first, second)
				}
			})
		})
	}
}

func TestMemoryExpiredHoldsAreIgnored(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	now := time.Now()
	m.Now = func() time.Time { return now }
	u, _ := m.UpsertUser(ctx, "ana@example.com")
	if _, ok, _ := m.Reserve(ctx, Hold{UserID: u.ID, Amount: 1000, Budget: 1000, ExpiresAt: now.Add(time.Minute)}); !ok {
		t.Fatal("hold refused")
	}
	now = now.Add(2 * time.Minute)
	if _, ok, _ := m.Reserve(ctx, Hold{UserID: u.ID, Amount: 1000, Budget: 1000, ExpiresAt: now.Add(time.Minute)}); !ok {
		t.Fatal("an expired hold still counted")
	}
}
