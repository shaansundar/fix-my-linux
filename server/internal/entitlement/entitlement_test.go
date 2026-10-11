package entitlement

import (
	"testing"
	"time"

	"fixmylinux.app/server/internal/catalog"
	"fixmylinux.app/server/internal/store"
)

func at(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		panic(err)
	}
	return t
}

func ptr(t time.Time) *time.Time { return &t }

func TestEvaluate(t *testing.T) {
	now := at("2026-10-11T12:00:00Z")
	trial := &store.Trial{StartedAt: at("2026-10-08T12:00:00Z"), EndsAt: at("2026-10-13T12:00:00Z")}
	oldTrial := &store.Trial{StartedAt: at("2026-09-01T00:00:00Z"), EndsAt: at("2026-09-06T00:00:00Z")}
	period := at("2026-10-01T09:00:00Z")
	sub := func(status string, ends *time.Time) *store.Subscription {
		return &store.Subscription{Status: status, CurrentPeriodStart: period, RenewsAt: ptr(at("2026-11-01T09:00:00Z")), EndsAt: ends}
	}

	tests := []struct {
		name        string
		trial       *store.Trial
		denied      bool
		sub         *store.Subscription
		state       State
		plan        catalog.PlanKind
		reason      string
		periodStart time.Time
		periodEnd   time.Time
	}{
		{name: "in trial", trial: trial, state: StateTrial, plan: catalog.PlanTrial,
			periodStart: at("2026-10-11T00:00:00Z"), periodEnd: at("2026-10-12T00:00:00Z")},
		{name: "trial over", trial: oldTrial, state: StateExpired, reason: ReasonTrialEnded},
		{name: "computer already used a trial", denied: true, state: StateExpired, reason: ReasonNoTrial},
		{name: "subscriber", trial: oldTrial, sub: sub("active", nil), state: StateActive, plan: catalog.PlanPaid,
			periodStart: period, periodEnd: at("2026-11-01T09:00:00Z")},
		{name: "subscribing during the trial switches to paid", trial: trial, sub: sub("active", nil), state: StateActive, plan: catalog.PlanPaid,
			periodStart: period, periodEnd: at("2026-11-01T09:00:00Z")},
		{name: "past due keeps access while the card is retried", sub: sub("past_due", nil), state: StateActive, plan: catalog.PlanPaid,
			periodStart: period, periodEnd: at("2026-11-01T09:00:00Z")},
		{name: "cancelled but paid up", sub: sub("cancelled", ptr(at("2026-11-01T09:00:00Z"))), state: StateActive, plan: catalog.PlanPaid,
			periodStart: period, periodEnd: at("2026-11-01T09:00:00Z")},
		{name: "cancelled and over", trial: oldTrial, sub: sub("cancelled", ptr(at("2026-10-10T00:00:00Z"))), state: StateExpired, reason: ReasonTrialEnded},
		{name: "unpaid", sub: sub("unpaid", nil), state: StateExpired, reason: ReasonPaymentIssue},
		{name: "expired subscription", trial: oldTrial, sub: sub("expired", nil), state: StateExpired, reason: ReasonTrialEnded},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := Evaluate(tt.trial, tt.denied, tt.sub, now)
			if e.State != tt.state || e.Plan != tt.plan || e.Reason != tt.reason {
				t.Fatalf("got state=%s plan=%s reason=%s", e.State, e.Plan, e.Reason)
			}
			if !tt.periodStart.IsZero() && (!e.PeriodStart.Equal(tt.periodStart) || !e.PeriodEnd.Equal(tt.periodEnd)) {
				t.Errorf("period = %v..%v, want %v..%v", e.PeriodStart, e.PeriodEnd, tt.periodStart, tt.periodEnd)
			}
			if e.CanUse() != (tt.state != StateExpired) {
				t.Errorf("CanUse = %v", e.CanUse())
			}
		})
	}
}

func TestPeriodRollsForwardWhenRenewalWebhookIsLate(t *testing.T) {
	now := at("2026-12-15T00:00:00Z")
	s := &store.Subscription{Status: "active", CurrentPeriodStart: at("2026-10-01T09:00:00Z"), RenewsAt: ptr(at("2026-11-01T09:00:00Z"))}
	e := Evaluate(nil, false, s, now)
	if !e.PeriodStart.Equal(at("2026-12-01T09:00:00Z")) || !e.PeriodEnd.Equal(at("2027-01-01T09:00:00Z")) {
		t.Fatalf("period = %v..%v", e.PeriodStart, e.PeriodEnd)
	}
}
