// Package httpapi is the desktop app's API: sign-in, account, model catalog,
// billing, Lemon Squeezy webhooks, and the Zen proxy mount.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"golang.org/x/time/rate"

	"fixmylinux.app/server/internal/auth"
	"fixmylinux.app/server/internal/billing"
	"fixmylinux.app/server/internal/catalog"
	"fixmylinux.app/server/internal/entitlement"
	"fixmylinux.app/server/internal/proxy"
	"fixmylinux.app/server/internal/store"
)

type Auth interface {
	Start(ctx context.Context, email string) error
	Verify(ctx context.Context, email, code, machineID string) (auth.Session, error)
	Authenticate(ctx context.Context, token string) (store.Device, store.User, error)
	SignOut(ctx context.Context, token string) error
}

type Accounts interface {
	TrialFor(ctx context.Context, userID string) (store.Trial, error)
	SubscriptionFor(ctx context.Context, userID string) (store.Subscription, error)
	SpentSince(ctx context.Context, userID string, since time.Time) (int64, error)
	RequestsSince(ctx context.Context, userID string, since time.Time) (int, error)
}

type Catalog interface {
	Provider() (*catalog.Provider, bool)
}

type Billing interface {
	CreateCheckout(ctx context.Context, user store.User) (string, error)
	PortalURL(ctx context.Context, subscriptionID string) (string, error)
}

type Webhooks interface {
	Handle(ctx context.Context, body []byte, signature string) error
}

type Deps struct {
	Auth               Auth
	Accounts           Accounts
	Catalog            Catalog
	Plans              catalog.PlanConfig
	Billing            Billing
	Webhooks           Webhooks
	BudgetMicros       int64
	TrialDailyRequests int
	Health             func(ctx context.Context) error
	Logger             *slog.Logger
	Now                func() time.Time
}

type Server struct {
	d       Deps
	router  chi.Router
	limiter *ipLimiter
}

func New(d Deps) *Server {
	if d.Now == nil {
		d.Now = time.Now
	}
	if d.Logger == nil {
		d.Logger = slog.Default()
	}
	s := &Server{d: d, router: chi.NewRouter(), limiter: newIPLimiter(rate.Every(6*time.Second), 10)}
	r := s.router
	r.Use(middleware.Recoverer)
	r.Get("/healthz", s.health)
	r.Route("/v1", func(r chi.Router) {
		r.With(s.rateLimit).Post("/auth/otp/start", s.otpStart)
		r.With(s.rateLimit).Post("/auth/otp/verify", s.otpVerify)
		r.With(s.authed).Post("/auth/signout", s.signOut)
		r.With(s.authed).Get("/me", s.me)
		r.With(s.authed).Get("/catalog", s.catalog)
		r.With(s.authed).Post("/billing/checkout", s.checkout)
		r.With(s.authed).Get("/billing/portal", s.portal)
		r.Post("/webhooks/lemonsqueezy", s.webhook)
	})
	return s
}

// Mount attaches the Zen proxy at /zen/v1/.
func (s *Server) Mount(p http.Handler) {
	s.router.Handle("/zen/v1/*", p)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.router.ServeHTTP(w, r) }

// ── helpers ─────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "That request couldn't be read.")
		return false
	}
	return true
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if t, ok := strings.CutPrefix(h, "Bearer "); ok {
		return strings.TrimSpace(t)
	}
	return ""
}

type ctxKey struct{}

type caller struct {
	user  store.User
	token string
}

func (s *Server) authed(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := bearer(r)
		_, user, err := s.d.Auth.Authenticate(r.Context(), token)
		if err != nil {
			if !errors.Is(err, auth.ErrInvalidToken) {
				s.d.Logger.Error("authenticate", "err", err)
			}
			writeError(w, http.StatusUnauthorized, "signed_out", "Sign in to continue.")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, caller{user: user, token: token})))
	})
}

func from(r *http.Request) caller { return r.Context().Value(ctxKey{}).(caller) }

// entitlementFor loads trial and subscription and evaluates them now.
func (s *Server) entitlementFor(ctx context.Context, userID string) (entitlement.Entitlement, *store.Subscription, error) {
	var trial *store.Trial
	denied := false
	t, err := s.d.Accounts.TrialFor(ctx, userID)
	switch {
	case err == nil:
		trial = &t
	case errors.Is(err, store.ErrNotFound):
		// Every sign-in tries to start a trial; none means the computer had one.
		denied = true
	default:
		return entitlement.Entitlement{}, nil, err
	}
	var sub *store.Subscription
	sb, err := s.d.Accounts.SubscriptionFor(ctx, userID)
	switch {
	case err == nil:
		sub = &sb
	case !errors.Is(err, store.ErrNotFound):
		return entitlement.Entitlement{}, nil, err
	}
	return entitlement.Evaluate(trial, denied, sub, s.d.Now()), sub, nil
}

// Resolve authenticates a proxy request; it is the proxy's Resolver.
func (s *Server) Resolve(r *http.Request) (proxy.Account, error) {
	_, user, err := s.d.Auth.Authenticate(r.Context(), bearer(r))
	if err != nil {
		return proxy.Account{}, proxy.ErrSignedOut
	}
	ent, _, err := s.entitlementFor(r.Context(), user.ID)
	if err != nil {
		return proxy.Account{}, err
	}
	return proxy.Account{UserID: user.ID, Entitlement: ent}, nil
}

// ── handlers ────────────────────────────────────────────────

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if s.d.Health != nil {
		if err := s.d.Health(ctx); err != nil {
			writeError(w, http.StatusServiceUnavailable, "unhealthy", err.Error())
			return
		}
	}
	if _, ok := s.d.Catalog.Provider(); !ok {
		writeError(w, http.StatusServiceUnavailable, "unhealthy", "model catalog not loaded")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func authError(w http.ResponseWriter, err error) bool {
	var status int
	var code string
	switch {
	case errors.Is(err, auth.ErrInvalidEmail):
		status, code = http.StatusBadRequest, "invalid_email"
	case errors.Is(err, auth.ErrTooManyCodes):
		status, code = http.StatusTooManyRequests, "too_many_codes"
	case errors.Is(err, auth.ErrInvalidCode):
		status, code = http.StatusBadRequest, "invalid_code"
	case errors.Is(err, auth.ErrCodeExpired):
		status, code = http.StatusBadRequest, "code_expired"
	case errors.Is(err, auth.ErrTooManyAttempts):
		status, code = http.StatusBadRequest, "too_many_attempts"
	default:
		return false
	}
	writeError(w, status, code, err.Error())
	return true
}

func (s *Server) otpStart(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email string `json:"email"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	if err := s.d.Auth.Start(r.Context(), req.Email); err != nil {
		if authError(w, err) {
			return
		}
		s.d.Logger.Error("otp start", "err", err)
		writeError(w, http.StatusBadGateway, "email_failed", "We couldn't send the email. Try again in a minute.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) otpVerify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email     string `json:"email"`
		Code      string `json:"code"`
		MachineID string `json:"machine_id"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	sess, err := s.d.Auth.Verify(r.Context(), req.Email, req.Code, req.MachineID)
	if err != nil {
		if authError(w, err) {
			return
		}
		s.d.Logger.Error("otp verify", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "Something went wrong. Try again.")
		return
	}
	acct, err := s.account(r.Context(), sess.User)
	if err != nil {
		s.d.Logger.Error("load account", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "Something went wrong. Try again.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"token": sess.Token, "account": acct})
}

func (s *Server) signOut(w http.ResponseWriter, r *http.Request) {
	if err := s.d.Auth.SignOut(r.Context(), from(r).token); err != nil {
		s.d.Logger.Error("sign out", "err", err)
	}
	w.WriteHeader(http.StatusNoContent)
}

// Account is what the desktop shows in the sidebar meter and paywall.
type Account struct {
	Email       string     `json:"email"`
	State       string     `json:"state"`
	Reason      string     `json:"reason,omitempty"`
	TrialEndsAt *time.Time `json:"trial_ends_at,omitempty"`
	PeriodStart *time.Time `json:"period_start,omitempty"`
	PeriodEnd   *time.Time `json:"period_end,omitempty"`
	CancelsAt   *time.Time `json:"cancels_at,omitempty"`
	BudgetUSD   float64    `json:"budget_usd,omitempty"`
	UsedUSD     float64    `json:"used_usd,omitempty"`
	DailyLimit  int        `json:"daily_limit,omitempty"`
	UsedToday   int        `json:"used_today,omitempty"`
}

func ptr(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

func (s *Server) account(ctx context.Context, user store.User) (Account, error) {
	ent, _, err := s.entitlementFor(ctx, user.ID)
	if err != nil {
		return Account{}, err
	}
	a := Account{Email: user.Email, State: string(ent.State), Reason: ent.Reason, TrialEndsAt: ent.TrialEndsAt, CancelsAt: ent.EndsAt}
	switch ent.State {
	case entitlement.StateActive:
		spent, err := s.d.Accounts.SpentSince(ctx, user.ID, ent.PeriodStart)
		if err != nil {
			return Account{}, err
		}
		a.PeriodStart, a.PeriodEnd = ptr(ent.PeriodStart), ptr(ent.PeriodEnd)
		a.BudgetUSD = float64(s.d.BudgetMicros) / 1e6
		a.UsedUSD = float64(spent) / 1e6
	case entitlement.StateTrial:
		n, err := s.d.Accounts.RequestsSince(ctx, user.ID, ent.PeriodStart)
		if err != nil {
			return Account{}, err
		}
		a.PeriodEnd = ptr(ent.PeriodEnd)
		a.DailyLimit, a.UsedToday = s.d.TrialDailyRequests, n
	}
	return a, nil
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	a, err := s.account(r.Context(), from(r).user)
	if err != nil {
		s.d.Logger.Error("load account", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "Something went wrong.")
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (s *Server) catalog(w http.ResponseWriter, r *http.Request) {
	provider, ok := s.d.Catalog.Provider()
	if !ok {
		writeError(w, http.StatusServiceUnavailable, "catalog_unavailable", "The assistant is briefly unavailable. Try again in a minute.")
		return
	}
	ent, _, err := s.entitlementFor(r.Context(), from(r).user.ID)
	if err != nil {
		s.d.Logger.Error("entitlement", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "Something went wrong.")
		return
	}
	// Expired accounts still get the free list so the app can start and show the paywall.
	kind := ent.Plan
	if kind == "" {
		kind = catalog.PlanTrial
	}
	plan, err := provider.PlanFor(kind, s.d.Plans)
	if err != nil {
		s.d.Logger.Error("plan", "err", err)
		writeError(w, http.StatusServiceUnavailable, "catalog_unavailable", "No models are available right now.")
		return
	}
	raw, err := provider.Subset(plan.Allowed)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "Something went wrong.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"provider": json.RawMessage(raw), "plan": plan})
}

func (s *Server) checkout(w http.ResponseWriter, r *http.Request) {
	url, err := s.d.Billing.CreateCheckout(r.Context(), from(r).user)
	if err != nil {
		s.d.Logger.Error("checkout", "err", err)
		writeError(w, http.StatusBadGateway, "checkout_failed", "We couldn't open the payment page. Try again in a minute.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func (s *Server) portal(w http.ResponseWriter, r *http.Request) {
	sub, err := s.d.Accounts.SubscriptionFor(r.Context(), from(r).user.ID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "no_subscription", "You don't have a subscription yet.")
		return
	}
	if err != nil {
		s.d.Logger.Error("portal", "err", err)
		writeError(w, http.StatusInternalServerError, "internal", "Something went wrong.")
		return
	}
	url, err := s.d.Billing.PortalURL(r.Context(), sub.LSID)
	if err != nil {
		s.d.Logger.Error("portal", "err", err)
		writeError(w, http.StatusBadGateway, "portal_failed", "We couldn't open your billing page. Try again in a minute.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"url": url})
}

func (s *Server) webhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "")
		return
	}
	if err := s.d.Webhooks.Handle(r.Context(), body, r.Header.Get("X-Signature")); err != nil {
		if errors.Is(err, billing.ErrBadSignature) {
			writeError(w, http.StatusUnauthorized, "bad_signature", "")
			return
		}
		s.d.Logger.Error("webhook", "err", err)
		// A 5xx makes Lemon Squeezy retry later.
		writeError(w, http.StatusInternalServerError, "internal", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── rate limiting ───────────────────────────────────────────

type ipLimiter struct {
	mu      sync.Mutex
	every   rate.Limit
	burst   int
	clients map[string]*limiterEntry
}

type limiterEntry struct {
	l    *rate.Limiter
	seen time.Time
}

func newIPLimiter(every rate.Limit, burst int) *ipLimiter {
	return &ipLimiter{every: every, burst: burst, clients: map[string]*limiterEntry{}}
}

func (l *ipLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.clients) > 10_000 {
		for k, e := range l.clients {
			if now.Sub(e.seen) > time.Hour {
				delete(l.clients, k)
			}
		}
	}
	e, ok := l.clients[ip]
	if !ok {
		e = &limiterEntry{l: rate.NewLimiter(l.every, l.burst)}
		l.clients[ip] = e
	}
	e.seen = now
	return e.l.AllowN(now, 1)
}

// clientIP is the last X-Forwarded-For hop: Railway's edge appends the real
// client address, while anything earlier in the header is client-supplied.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if ip := strings.TrimSpace(parts[len(parts)-1]); ip != "" {
			return ip
		}
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

func (s *Server) rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.limiter.allow(clientIP(r), s.d.Now()) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many tries. Wait a minute and try again.")
			return
		}
		next.ServeHTTP(w, r)
	})
}
