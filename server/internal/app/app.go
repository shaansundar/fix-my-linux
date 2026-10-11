// Package app wires the server's parts together from config.
package app

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"fixmylinux.app/server/internal/auth"
	"fixmylinux.app/server/internal/billing"
	"fixmylinux.app/server/internal/catalog"
	"fixmylinux.app/server/internal/config"
	"fixmylinux.app/server/internal/httpapi"
	"fixmylinux.app/server/internal/mail"
	"fixmylinux.app/server/internal/proxy"
	"fixmylinux.app/server/internal/store"
)

// datastore is everything the server needs from persistence.
type datastore interface {
	auth.Store
	billing.Store
	proxy.Ledger
	httpapi.Accounts
}

type App struct {
	Handler http.Handler
	close   func()
}

func (a *App) Close() {
	if a.close != nil {
		a.close()
	}
}

// Options let tests swap the outside world.
type Options struct {
	Store   datastore
	Mailer  auth.Mailer
	Billing httpapi.Billing
	Fetcher catalog.Fetcher
	Client  *http.Client
	Now     func() time.Time
}

func Build(ctx context.Context, cfg config.Config, logger *slog.Logger) (*App, error) {
	return BuildWith(ctx, cfg, logger, Options{})
}

func BuildWith(ctx context.Context, cfg config.Config, logger *slog.Logger, opt Options) (*App, error) {
	a := &App{}
	var health func(context.Context) error

	st := opt.Store
	if st == nil {
		if cfg.DevMemory {
			logger.Warn("using the in-memory store; data is lost on restart")
			st = store.NewMemory()
		} else {
			pg, err := store.Open(ctx, cfg.DatabaseURL)
			if err != nil {
				return nil, err
			}
			st, health, a.close = pg, pg.Ping, pg.Close
		}
	}

	mailer := opt.Mailer
	if mailer == nil {
		if cfg.ResendAPIKey != "" {
			mailer = mail.Resend{APIKey: cfg.ResendAPIKey, From: cfg.MailFrom}
		} else {
			mailer = mail.Log{Logger: logger}
		}
	}

	client := opt.Client
	if client == nil {
		client = &http.Client{}
	}
	fetch := opt.Fetcher
	if fetch == nil {
		fetch = catalog.HTTPFetcher(&http.Client{Timeout: 20 * time.Second}, cfg.ModelsURL)
	}
	cat := catalog.NewService(fetch)
	if err := cat.Refresh(ctx); err != nil {
		// Keep starting; /healthz reports it and the refresh loop retries.
		logger.Error("initial catalog load failed", "err", err)
	}
	runCtx, cancelRun := context.WithCancel(context.Background())
	go cat.Run(runCtx, time.Hour, func(err error) { logger.Warn("catalog refresh failed", "err", err) })
	prevClose := a.close
	a.close = func() {
		cancelRun()
		if prevClose != nil {
			prevClose()
		}
	}

	now := opt.Now
	if now == nil {
		now = time.Now
	}
	authOpts := []auth.Option{auth.WithClock(now), auth.WithTrialLength(cfg.TrialLength)}
	authSvc := auth.New(st, mailer, cfg.CodeSecret, cfg.MachineSecret, authOpts...)

	bill := opt.Billing
	if bill == nil {
		bill = billing.LemonSqueezy{
			APIKey: cfg.LemonAPIKey, StoreID: cfg.LemonStoreID, VariantID: cfg.LemonVariantID,
			RedirectURL: cfg.CheckoutRedirect, Client: client,
		}
	}

	api := httpapi.New(httpapi.Deps{
		Auth:               authSvc,
		Accounts:           st,
		Catalog:            cat,
		Plans:              cfg.Plans,
		Billing:            bill,
		Webhooks:           billing.NewWebhooks(st, cfg.LemonWebhookSecret, logger),
		BudgetMicros:       cfg.BudgetMicros,
		TrialDailyRequests: cfg.TrialDailyRequests,
		Health:             health,
		Logger:             logger,
		Now:                now,
	})
	api.Mount(proxy.New(proxy.Config{
		Upstream:           cfg.ZenBaseURL,
		ZenKey:             cfg.ZenAPIKey,
		BudgetMicros:       cfg.BudgetMicros,
		TrialDailyRequests: cfg.TrialDailyRequests,
		Plans:              cfg.Plans,
		Client:             client,
		Logger:             logger,
		Now:                now,
	}, st, cat, api.Resolve))

	a.Handler = api
	return a, nil
}
