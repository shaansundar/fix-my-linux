package config

import (
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

var secret = strings.Repeat("s", 32)

func TestLoad(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr string
		check   func(t *testing.T, c Config)
	}{
		{
			name: "development defaults",
			env:  map[string]string{"FML_DEV_MEMORY": "1", "ZEN_API_KEY": "z", "CODE_SECRET": secret, "MACHINE_HMAC_SECRET": secret},
			check: func(t *testing.T, c Config) {
				if c.BudgetMicros != 8_000_000 || c.TrialLength != 5*24*time.Hour || c.TrialDailyRequests != 300 || c.Addr != ":8080" {
					t.Errorf("defaults = %+v", c)
				}
				if c.Plans.PaidDefault != "claude-haiku-4-5" || len(c.Plans.PaidModels) == 0 {
					t.Errorf("plans = %+v", c.Plans)
				}
			},
		},
		{
			name: "overrides",
			env: map[string]string{"FML_DEV_MEMORY": "1", "ZEN_API_KEY": "z", "CODE_SECRET": secret, "MACHINE_HMAC_SECRET": secret,
				"PORT": "9000", "BUDGET_USD": "10", "PAID_MODELS": "a, b ,", "TRIAL_DAYS": "7"},
			check: func(t *testing.T, c Config) {
				if c.Addr != ":9000" || c.BudgetMicros != 10_000_000 || c.TrialLength != 7*24*time.Hour {
					t.Errorf("config = %+v", c)
				}
				if len(c.Plans.PaidModels) != 2 || c.Plans.PaidModels[1] != "b" {
					t.Errorf("paid models = %v", c.Plans.PaidModels)
				}
			},
		},
		{name: "production needs everything", env: map[string]string{"ZEN_API_KEY": "z", "CODE_SECRET": secret, "MACHINE_HMAC_SECRET": secret}, wantErr: "DATABASE_URL"},
		{name: "short secrets", env: map[string]string{"FML_DEV_MEMORY": "1", "ZEN_API_KEY": "z", "CODE_SECRET": "x", "MACHINE_HMAC_SECRET": secret}, wantErr: "CODE_SECRET"},
		{name: "bad number", env: map[string]string{"FML_DEV_MEMORY": "1", "BUDGET_USD": "eight"}, wantErr: "BUDGET_USD"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c, err := Load(env(tt.env))
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			tt.check(t, c)
		})
	}
}
