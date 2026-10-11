// Package auth signs people in with a 6-digit email code and issues device
// tokens. The free trial starts on first sign-in, bound to the account and to
// an HMAC of the computer's machine-id.
package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net/mail"
	"strings"
	"time"

	"fixmylinux.app/server/internal/store"
)

var (
	ErrInvalidEmail    = errors.New("that doesn't look like an email address")
	ErrTooManyCodes    = errors.New("too many codes requested; try again later")
	ErrInvalidCode     = errors.New("that code isn't right")
	ErrCodeExpired     = errors.New("that code has expired; ask for a new one")
	ErrTooManyAttempts = errors.New("too many wrong codes; ask for a new one")
	ErrInvalidToken    = errors.New("signed out")
)

const (
	codeTTL         = 10 * time.Minute
	maxAttempts     = 5
	maxCodesPerHr   = 5
	tokenPrefix     = "fml_"
	DefaultTrialLen = 5 * 24 * time.Hour
)

// Store is what auth needs from persistence.
type Store interface {
	CreateOTP(ctx context.Context, email string, codeHash []byte, expiresAt time.Time) error
	LatestOTP(ctx context.Context, email string) (store.OTP, error)
	BumpOTPAttempts(ctx context.Context, id int64) (int, error)
	ConsumeOTP(ctx context.Context, id int64) error
	CountOTPsSince(ctx context.Context, email string, since time.Time) (int, error)
	UpsertUser(ctx context.Context, email string) (store.User, error)
	CreateDevice(ctx context.Context, userID string, tokenHash, machineHash []byte) (store.Device, error)
	DeviceByToken(ctx context.Context, tokenHash []byte) (store.Device, store.User, error)
	RevokeDevice(ctx context.Context, tokenHash []byte) error
	StartTrial(ctx context.Context, userID string, machineHash []byte, start time.Time, length time.Duration) (store.Trial, error)
}

type Mailer interface {
	SendCode(ctx context.Context, to, code string) error
}

type Service struct {
	store Store
	mail  Mailer
	// Peppers code hashes so a database leak doesn't reveal live codes.
	codeSecret []byte
	// Keys the machine-id HMAC so raw machine ids are never stored.
	machineSecret []byte
	trialLen      time.Duration
	now           func() time.Time
}

type Option func(*Service)

func WithClock(now func() time.Time) Option  { return func(s *Service) { s.now = now } }
func WithTrialLength(d time.Duration) Option { return func(s *Service) { s.trialLen = d } }

func New(st Store, m Mailer, codeSecret, machineSecret []byte, opts ...Option) *Service {
	s := &Service{store: st, mail: m, codeSecret: codeSecret, machineSecret: machineSecret, trialLen: DefaultTrialLen, now: time.Now}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// NormalizeEmail lowercases and validates an address.
func NormalizeEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email || !strings.Contains(email[strings.LastIndex(email, "@"):], ".") || len(email) > 254 {
		return "", ErrInvalidEmail
	}
	return email, nil
}

func (s *Service) codeHash(email, code string) []byte {
	m := hmac.New(sha256.New, s.codeSecret)
	m.Write([]byte(email + ":" + code))
	return m.Sum(nil)
}

// MachineHash is the stored stand-in for a machine-id.
func (s *Service) MachineHash(machineID string) []byte {
	m := hmac.New(sha256.New, s.machineSecret)
	m.Write([]byte(strings.TrimSpace(machineID)))
	return m.Sum(nil)
}

func newCode() (string, error) {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("failed to generate code: %w", err)
	}
	return fmt.Sprintf("%06d", binary.BigEndian.Uint32(b[:])%1_000_000), nil
}

// Start emails a fresh code. It succeeds silently for any valid address so
// it can't be used to discover who has an account.
func (s *Service) Start(ctx context.Context, rawEmail string) error {
	email, err := NormalizeEmail(rawEmail)
	if err != nil {
		return err
	}
	n, err := s.store.CountOTPsSince(ctx, email, s.now().Add(-time.Hour))
	if err != nil {
		return fmt.Errorf("failed to check code rate: %w", err)
	}
	if n >= maxCodesPerHr {
		return ErrTooManyCodes
	}
	code, err := newCode()
	if err != nil {
		return err
	}
	if err := s.store.CreateOTP(ctx, email, s.codeHash(email, code), s.now().Add(codeTTL)); err != nil {
		return fmt.Errorf("failed to save code: %w", err)
	}
	if err := s.mail.SendCode(ctx, email, code); err != nil {
		return fmt.Errorf("failed to email code: %w", err)
	}
	return nil
}

// Session is the result of a successful sign-in.
type Session struct {
	Token string
	User  store.User
	// TrialDenied means this computer already used a free trial with another account.
	TrialDenied bool
}

// Verify checks the code and issues a device token.
func (s *Service) Verify(ctx context.Context, rawEmail, code, machineID string) (Session, error) {
	email, err := NormalizeEmail(rawEmail)
	if err != nil {
		return Session{}, err
	}
	code = strings.TrimSpace(code)
	if len(code) != 6 || strings.Trim(code, "0123456789") != "" {
		return Session{}, ErrInvalidCode
	}
	if strings.TrimSpace(machineID) == "" {
		return Session{}, errors.New("missing machine id")
	}
	otp, err := s.store.LatestOTP(ctx, email)
	if errors.Is(err, store.ErrNotFound) {
		return Session{}, ErrInvalidCode
	}
	if err != nil {
		return Session{}, fmt.Errorf("failed to load code: %w", err)
	}
	if otp.ConsumedAt != nil {
		return Session{}, ErrInvalidCode
	}
	if !s.now().Before(otp.ExpiresAt) {
		return Session{}, ErrCodeExpired
	}
	if otp.Attempts >= maxAttempts {
		return Session{}, ErrTooManyAttempts
	}
	if subtle.ConstantTimeCompare(otp.CodeHash, s.codeHash(email, code)) != 1 {
		n, err := s.store.BumpOTPAttempts(ctx, otp.ID)
		if err != nil {
			return Session{}, fmt.Errorf("failed to count attempt: %w", err)
		}
		if n >= maxAttempts {
			return Session{}, ErrTooManyAttempts
		}
		return Session{}, ErrInvalidCode
	}
	if err := s.store.ConsumeOTP(ctx, otp.ID); err != nil {
		// Lost a race with a concurrent verify of the same code.
		return Session{}, ErrInvalidCode
	}

	user, err := s.store.UpsertUser(ctx, email)
	if err != nil {
		return Session{}, fmt.Errorf("failed to create account: %w", err)
	}
	machine := s.MachineHash(machineID)
	denied := false
	if _, err := s.store.StartTrial(ctx, user.ID, machine, s.now(), s.trialLen); errors.Is(err, store.ErrTrialUsed) {
		denied = true
	} else if err != nil {
		return Session{}, fmt.Errorf("failed to start trial: %w", err)
	}

	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return Session{}, fmt.Errorf("failed to generate token: %w", err)
	}
	token := tokenPrefix + base64.RawURLEncoding.EncodeToString(raw)
	if _, err := s.store.CreateDevice(ctx, user.ID, tokenHash(token), machine); err != nil {
		return Session{}, fmt.Errorf("failed to register device: %w", err)
	}
	return Session{Token: token, User: user, TrialDenied: denied}, nil
}

func tokenHash(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}

// Authenticate resolves a device token.
func (s *Service) Authenticate(ctx context.Context, token string) (store.Device, store.User, error) {
	if !strings.HasPrefix(token, tokenPrefix) || len(token) > 128 {
		return store.Device{}, store.User{}, ErrInvalidToken
	}
	d, u, err := s.store.DeviceByToken(ctx, tokenHash(token))
	if errors.Is(err, store.ErrNotFound) {
		return store.Device{}, store.User{}, ErrInvalidToken
	}
	if err != nil {
		return store.Device{}, store.User{}, fmt.Errorf("failed to check token: %w", err)
	}
	return d, u, nil
}

// SignOut revokes a device token.
func (s *Service) SignOut(ctx context.Context, token string) error {
	if err := s.store.RevokeDevice(ctx, tokenHash(token)); err != nil {
		return fmt.Errorf("failed to sign out: %w", err)
	}
	return nil
}
