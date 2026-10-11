// Command api is the Fix My Linux backend: sign-in, subscriptions and the
// metered OpenCode Zen proxy the desktop app talks to.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"fixmylinux.app/server/internal/app"
	"fixmylinux.app/server/internal/config"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logger.Error("server stopped", "err", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	cfg, err := config.Load(os.Getenv)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	a, err := app.Build(ctx, cfg, logger)
	if err != nil {
		return err
	}
	defer a.Close()

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           a.Handler,
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: model responses stream for minutes.
		IdleTimeout: 120 * time.Second,
	}
	errs := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", cfg.Addr)
		errs <- srv.ListenAndServe()
	}()

	select {
	case err := <-errs:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		logger.Info("shutting down")
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	return srv.Shutdown(shutdown)
}
