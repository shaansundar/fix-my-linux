// Package config reads the server's settings from the environment.
package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"fixmylinux.app/server/internal/catalog"
)

type Config struct {
	Addr        string
	DatabaseURL string
	// Development: no database (in-memory store) and codes printed to the log.
	DevMemory bool

	ZenBaseURL string
	ZenAPIKey  string
	ModelsURL  string

	ResendAPIKey string
	MailFrom     string

	CodeSecret    []byte
	MachineSecret []byte

	LemonAPIKey        string
	LemonStoreID       string
	LemonVariantID     string
	LemonWebhookSecret []byte
	CheckoutRedirect   string

	BudgetMicros       int64
	TrialLength        time.Duration
	TrialDailyRequests int
	Plans              catalog.PlanConfig
}

// Default paid models: good tool use at a price the $8 allowance stretches over.
var defaultPaid = []string{"claude-haiku-4-5", "claude-sonnet-4-6", "gpt-5.4-mini", "gpt-5.4-nano", "kimi-k2.6", "deepseek-v4-flash", "gemini-3-flash"}

// Load builds the config; get is os.Getenv in production.
func Load(get func(string) string) (Config, error) {
	str := func(k, def string) string {
		if v := strings.TrimSpace(get(k)); v != "" {
			return v
		}
		return def
	}
	num := func(k string, def float64) (float64, error) {
		v := get(k)
		if v == "" {
			return def, nil
		}
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			return 0, fmt.Errorf("%s must be a number: %w", k, err)
		}
		return f, nil
	}
	list := func(k string, def []string) []string {
		v := get(k)
		if v == "" {
			return def
		}
		var out []string
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out
	}

	c := Config{
		Addr:             ":" + str("PORT", "8080"),
		DatabaseURL:      str("DATABASE_URL", ""),
		DevMemory:        get("FML_DEV_MEMORY") == "1",
		ZenBaseURL:       str("ZEN_BASE_URL", "https://opencode.ai/zen/v1"),
		ZenAPIKey:        str("ZEN_API_KEY", ""),
		ModelsURL:        str("MODELS_URL", "https://models.opencode.ai/api.json"),
		ResendAPIKey:     str("RESEND_API_KEY", ""),
		MailFrom:         str("MAIL_FROM", "Fix My Linux <hello@fixmylinux.app>"),
		CodeSecret:       []byte(str("CODE_SECRET", "")),
		MachineSecret:    []byte(str("MACHINE_HMAC_SECRET", "")),
		LemonAPIKey:      str("LEMONSQUEEZY_API_KEY", ""),
		LemonStoreID:     str("LEMONSQUEEZY_STORE_ID", ""),
		LemonVariantID:   str("LEMONSQUEEZY_VARIANT_ID", ""),
		CheckoutRedirect: str("CHECKOUT_REDIRECT_URL", "https://fixmylinux.app/welcome"),
		Plans: catalog.PlanConfig{
			PaidModels:     list("PAID_MODELS", defaultPaid),
			PaidDefault:    str("PAID_DEFAULT_MODEL", "claude-haiku-4-5"),
			PaidSmall:      str("PAID_SMALL_MODEL", "gpt-5.4-nano"),
			FreePreference: list("FREE_PREFERENCE", []string{"big-pickle", "nemotron-3-ultra-free", "mimo-v2.6-flash-free"}),
		},
	}
	c.LemonWebhookSecret = []byte(str("LEMONSQUEEZY_WEBHOOK_SECRET", ""))

	budget, err := num("BUDGET_USD", 8)
	if err != nil {
		return Config{}, err
	}
	c.BudgetMicros = int64(budget * 1_000_000)
	days, err := num("TRIAL_DAYS", 5)
	if err != nil {
		return Config{}, err
	}
	c.TrialLength = time.Duration(days * float64(24*time.Hour))
	daily, err := num("TRIAL_DAILY_REQUESTS", 300)
	if err != nil {
		return Config{}, err
	}
	c.TrialDailyRequests = int(daily)

	var problems []string
	need := func(ok bool, msg string) {
		if !ok {
			problems = append(problems, msg)
		}
	}
	need(c.ZenAPIKey != "", "ZEN_API_KEY is required")
	need(len(c.CodeSecret) >= 32, "CODE_SECRET must be at least 32 characters")
	need(len(c.MachineSecret) >= 32, "MACHINE_HMAC_SECRET must be at least 32 characters")
	if !c.DevMemory {
		need(c.DatabaseURL != "", "DATABASE_URL is required (or FML_DEV_MEMORY=1 for development)")
		need(c.ResendAPIKey != "", "RESEND_API_KEY is required (or FML_DEV_MEMORY=1 to log codes)")
		need(c.LemonAPIKey != "" && c.LemonStoreID != "" && c.LemonVariantID != "", "LEMONSQUEEZY_API_KEY, _STORE_ID and _VARIANT_ID are required")
		need(len(c.LemonWebhookSecret) > 0, "LEMONSQUEEZY_WEBHOOK_SECRET is required")
	}
	if len(problems) > 0 {
		return Config{}, errors.New(strings.Join(problems, "; "))
	}
	return c, nil
}
