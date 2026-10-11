package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"
)

// Memory is an in-process Store for tests and local development.
type Memory struct {
	Now func() time.Time

	mu       sync.Mutex
	users    map[string]User
	byEmail  map[string]string
	otps     []OTP
	devices  map[string]memDevice
	trials   map[string]memTrial
	subs     map[string]Subscription
	usage    []UsageRecord
	holds    map[string]Hold
	webhooks map[string]bool
	nextOTP  int64
}

type memDevice struct {
	Device
	tokenHash []byte
	revoked   bool
}

type memTrial struct {
	Trial
	machineHash []byte
}

func NewMemory() *Memory {
	return &Memory{
		Now:      time.Now,
		users:    map[string]User{},
		byEmail:  map[string]string{},
		devices:  map[string]memDevice{},
		trials:   map[string]memTrial{},
		subs:     map[string]Subscription{},
		holds:    map[string]Hold{},
		webhooks: map[string]bool{},
	}
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (m *Memory) CreateOTP(_ context.Context, email string, codeHash []byte, expiresAt time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextOTP++
	m.otps = append(m.otps, OTP{ID: m.nextOTP, Email: email, CodeHash: codeHash, ExpiresAt: expiresAt, CreatedAt: m.Now()})
	return nil
}

func (m *Memory) LatestOTP(_ context.Context, email string) (OTP, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := len(m.otps) - 1; i >= 0; i-- {
		if m.otps[i].Email == email {
			return m.otps[i], nil
		}
	}
	return OTP{}, ErrNotFound
}

func (m *Memory) BumpOTPAttempts(_ context.Context, id int64) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.otps {
		if m.otps[i].ID == id {
			m.otps[i].Attempts++
			return m.otps[i].Attempts, nil
		}
	}
	return 0, ErrNotFound
}

func (m *Memory) ConsumeOTP(_ context.Context, id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for i := range m.otps {
		if m.otps[i].ID == id {
			now := m.Now()
			m.otps[i].ConsumedAt = &now
			return nil
		}
	}
	return ErrNotFound
}

func (m *Memory) CountOTPsSince(_ context.Context, email string, since time.Time) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, o := range m.otps {
		if o.Email == email && !o.CreatedAt.Before(since) {
			n++
		}
	}
	return n, nil
}

func (m *Memory) UpsertUser(_ context.Context, email string) (User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if id, ok := m.byEmail[email]; ok {
		return m.users[id], nil
	}
	u := User{ID: newID(), Email: email, CreatedAt: m.Now()}
	m.users[u.ID] = u
	m.byEmail[email] = u.ID
	return u, nil
}

func (m *Memory) UserByID(_ context.Context, id string) (User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	u, ok := m.users[id]
	if !ok {
		return User{}, ErrNotFound
	}
	return u, nil
}

func (m *Memory) CreateDevice(_ context.Context, userID string, tokenHash, machineHash []byte) (Device, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := Device{ID: newID(), UserID: userID, MachineHash: machineHash, CreatedAt: m.Now(), LastSeenAt: m.Now()}
	m.devices[d.ID] = memDevice{Device: d, tokenHash: tokenHash}
	return d, nil
}

func (m *Memory) DeviceByToken(_ context.Context, tokenHash []byte) (Device, User, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, d := range m.devices {
		if !d.revoked && bytes.Equal(d.tokenHash, tokenHash) {
			d.LastSeenAt = m.Now()
			m.devices[id] = d
			return d.Device, m.users[d.UserID], nil
		}
	}
	return Device{}, User{}, ErrNotFound
}

func (m *Memory) RevokeDevice(_ context.Context, tokenHash []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, d := range m.devices {
		if bytes.Equal(d.tokenHash, tokenHash) {
			d.revoked = true
			m.devices[id] = d
		}
	}
	return nil
}

func (m *Memory) StartTrial(_ context.Context, userID string, machineHash []byte, start time.Time, length time.Duration) (Trial, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if t, ok := m.trials[userID]; ok {
		return t.Trial, nil
	}
	for _, t := range m.trials {
		if bytes.Equal(t.machineHash, machineHash) {
			return Trial{}, ErrTrialUsed
		}
	}
	t := Trial{UserID: userID, StartedAt: start, EndsAt: start.Add(length)}
	m.trials[userID] = memTrial{Trial: t, machineHash: machineHash}
	return t, nil
}

func (m *Memory) TrialFor(_ context.Context, userID string) (Trial, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.trials[userID]
	if !ok {
		return Trial{}, ErrNotFound
	}
	return t.Trial, nil
}

func (m *Memory) UpsertSubscription(_ context.Context, s Subscription) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if prev, ok := m.subs[s.LSID]; ok {
		if prev.LSUpdatedAt != nil && s.LSUpdatedAt != nil && s.LSUpdatedAt.Before(*prev.LSUpdatedAt) {
			return nil
		}
		if s.CurrentPeriodStart.IsZero() {
			s.CurrentPeriodStart = prev.CurrentPeriodStart
		}
	}
	s.UpdatedAt = m.Now()
	m.subs[s.LSID] = s
	return nil
}

func (m *Memory) SubscriptionFor(_ context.Context, userID string) (Subscription, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var best *Subscription
	for _, s := range m.subs {
		if s.UserID == userID && (best == nil || s.UpdatedAt.After(best.UpdatedAt)) {
			s := s
			best = &s
		}
	}
	if best == nil {
		return Subscription{}, ErrNotFound
	}
	return *best, nil
}

func (m *Memory) SubscriptionByLSID(_ context.Context, lsID string) (Subscription, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.subs[lsID]
	if !ok {
		return Subscription{}, ErrNotFound
	}
	return s, nil
}

func (m *Memory) SetPeriodStart(_ context.Context, lsID string, t time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.subs[lsID]
	if !ok {
		return ErrNotFound
	}
	s.CurrentPeriodStart = t
	m.subs[lsID] = s
	return nil
}

func (m *Memory) spentLocked(userID string, since time.Time) int64 {
	var total int64
	for _, u := range m.usage {
		if u.UserID == userID && !u.CreatedAt.Before(since) {
			total += u.CostMicros
		}
	}
	return total
}

func (m *Memory) Reserve(_ context.Context, h Hold) (string, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.Now()
	held := int64(0)
	for id, other := range m.holds {
		if !other.ExpiresAt.After(now) {
			delete(m.holds, id)
			continue
		}
		if other.UserID == h.UserID {
			held += other.Amount
		}
	}
	if m.spentLocked(h.UserID, h.PeriodStart)+held+h.Amount > h.Budget {
		return "", false, nil
	}
	id := newID()
	m.holds[id] = h
	return id, true, nil
}

func (m *Memory) Settle(_ context.Context, reservationID string, rec UsageRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.holds, reservationID)
	m.usage = append(m.usage, rec)
	return nil
}

func (m *Memory) Release(_ context.Context, reservationID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.holds, reservationID)
	return nil
}

func (m *Memory) RecordUsage(_ context.Context, rec UsageRecord) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.usage = append(m.usage, rec)
	return nil
}

func (m *Memory) SpentSince(_ context.Context, userID string, since time.Time) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.spentLocked(userID, since), nil
}

func (m *Memory) RequestsSince(_ context.Context, userID string, since time.Time) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, u := range m.usage {
		if u.UserID == userID && !u.CreatedAt.Before(since) {
			n++
		}
	}
	return n, nil
}

func (m *Memory) FirstSeen(_ context.Context, bodyHash []byte) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := hex.EncodeToString(bodyHash)
	if m.webhooks[key] {
		return false, nil
	}
	m.webhooks[key] = true
	return true, nil
}
