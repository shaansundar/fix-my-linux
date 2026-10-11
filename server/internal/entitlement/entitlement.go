// Package entitlement decides what an account may use right now.
package entitlement

import (
	"time"

	"fixmylinux.app/server/internal/catalog"
	"fixmylinux.app/server/internal/store"
)

type State string

const (
	// Free trial on Zen's free models.
	StateTrial State = "trial"
	// Paying subscriber.
	StateActive State = "active"
	// Trial over (or never available on this computer) and no subscription.
	StateExpired State = "expired"
)

// Reason codes the desktop maps to a paywall or notice.
const (
	ReasonTrialEnded   = "trial_ended"
	ReasonNoTrial      = "trial_unavailable"
	ReasonPaymentIssue = "payment_required"
)

type Entitlement struct {
	State State
	Plan  catalog.PlanKind
	// Set during the trial.
	TrialEndsAt *time.Time
	// Billing period for subscribers; usage counts from PeriodStart.
	PeriodStart time.Time
	PeriodEnd   time.Time
	// Set when the subscription is cancelled but paid up until then.
	EndsAt *time.Time
	// Reason is set when State is StateExpired.
	Reason string
}

// CanUse reports whether model calls are allowed at all.
func (e Entitlement) CanUse() bool { return e.State != StateExpired }

// Lemon Squeezy statuses that still grant access. past_due keeps access while
// the store retries the card; cancelled keeps it until ends_at.
func subscriptionActive(s store.Subscription, now time.Time) bool {
	switch s.Status {
	case "active", "on_trial", "past_due":
		return true
	case "cancelled":
		return s.EndsAt != nil && now.Before(*s.EndsAt)
	default:
		return false
	}
}

// Evaluate combines the trial and the latest subscription. trial or sub may be nil.
func Evaluate(trial *store.Trial, trialDenied bool, sub *store.Subscription, now time.Time) Entitlement {
	if sub != nil && subscriptionActive(*sub, now) {
		e := Entitlement{State: StateActive, Plan: catalog.PlanPaid, PeriodStart: sub.CurrentPeriodStart}
		switch {
		case sub.RenewsAt != nil && sub.RenewsAt.After(sub.CurrentPeriodStart):
			e.PeriodEnd = *sub.RenewsAt
		default:
			e.PeriodEnd = sub.CurrentPeriodStart.AddDate(0, 1, 0)
		}
		if sub.Status == "cancelled" {
			e.EndsAt = sub.EndsAt
		}
		// A missed renewal webhook must not leave the period open-ended.
		for !now.Before(e.PeriodEnd) {
			e.PeriodStart = e.PeriodEnd
			e.PeriodEnd = e.PeriodEnd.AddDate(0, 1, 0)
		}
		return e
	}
	if trial != nil && now.Before(trial.EndsAt) {
		ends := trial.EndsAt
		return Entitlement{State: StateTrial, Plan: catalog.PlanTrial, TrialEndsAt: &ends, PeriodStart: startOfDay(now), PeriodEnd: startOfDay(now).AddDate(0, 0, 1)}
	}
	reason := ReasonTrialEnded
	switch {
	case sub != nil && (sub.Status == "unpaid" || sub.Status == "past_due"):
		reason = ReasonPaymentIssue
	case trial == nil && trialDenied:
		reason = ReasonNoTrial
	}
	return Entitlement{State: StateExpired, Reason: reason}
}

func startOfDay(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}
