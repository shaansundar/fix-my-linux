// Package store persists accounts, trials, subscriptions and usage. Postgres
// is the real implementation; Memory backs fast unit tests. Consumers define
// the narrow interfaces they need.
package store

import (
	"errors"
	"time"
)

var (
	ErrNotFound  = errors.New("not found")
	ErrTrialUsed = errors.New("this computer already used its free trial")
)

type User struct {
	ID        string
	Email     string
	CreatedAt time.Time
}

type OTP struct {
	ID         int64
	Email      string
	CodeHash   []byte
	ExpiresAt  time.Time
	Attempts   int
	ConsumedAt *time.Time
	CreatedAt  time.Time
}

type Device struct {
	ID          string
	UserID      string
	MachineHash []byte
	CreatedAt   time.Time
	LastSeenAt  time.Time
}

type Trial struct {
	UserID    string
	StartedAt time.Time
	EndsAt    time.Time
}

type Subscription struct {
	LSID               string
	UserID             string
	Status             string
	CustomerID         string
	RenewsAt           *time.Time
	EndsAt             *time.Time
	CurrentPeriodStart time.Time
	// Lemon Squeezy's updated_at for the state stored; nil if unknown.
	LSUpdatedAt *time.Time
	UpdatedAt   time.Time
}

type UsageRecord struct {
	UserID     string
	Model      string
	Input      int64
	Output     int64
	CacheRead  int64
	CacheWrite int64
	CostMicros int64
	// The real usage was unknown; the reservation estimate was charged.
	Estimated bool
	CreatedAt time.Time
}

// Hold is a request to reserve spend against a budget.
type Hold struct {
	UserID      string
	Amount      int64
	Budget      int64
	PeriodStart time.Time
	ExpiresAt   time.Time
}
