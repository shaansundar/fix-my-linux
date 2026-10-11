package auth

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"fixmylinux.app/server/internal/store"
)

type inbox struct {
	mu    sync.Mutex
	codes map[string]string
	fail  error
}

func (i *inbox) SendCode(_ context.Context, to, code string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.fail != nil {
		return i.fail
	}
	i.codes[to] = code
	return nil
}

type fixture struct {
	svc   *Service
	mem   *store.Memory
	inbox *inbox
	now   time.Time
}

func setup(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{mem: store.NewMemory(), inbox: &inbox{codes: map[string]string{}}, now: time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)}
	f.mem.Now = func() time.Time { return f.now }
	f.svc = New(f.mem, f.inbox, []byte("code-secret"), []byte("machine-secret"), WithClock(func() time.Time { return f.now }))
	return f
}

func TestNormalizeEmail(t *testing.T) {
	tests := []struct {
		in   string
		want string
		err  bool
	}{
		{"  Ana@Example.COM ", "ana@example.com", false},
		{"ana@example", "", true},
		{"not an email", "", true},
		{"Ana <ana@example.com>", "", true},
		{"", "", true},
	}
	for _, tt := range tests {
		got, err := NormalizeEmail(tt.in)
		if (err != nil) != tt.err || got != tt.want {
			t.Errorf("NormalizeEmail(%q) = %q, %v", tt.in, got, err)
		}
	}
}

func TestSignInFlow(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	if err := f.svc.Start(ctx, "Ana@Example.com"); err != nil {
		t.Fatal(err)
	}
	code := f.inbox.codes["ana@example.com"]
	if len(code) != 6 {
		t.Fatalf("code = %q", code)
	}

	sess, err := f.svc.Verify(ctx, "ana@example.com", code, "machine-1\n")
	if err != nil {
		t.Fatal(err)
	}
	if sess.User.Email != "ana@example.com" || sess.TrialDenied || len(sess.Token) < 40 {
		t.Fatalf("session = %+v", sess)
	}
	trial, err := f.mem.TrialFor(ctx, sess.User.ID)
	if err != nil || !trial.EndsAt.Equal(f.now.Add(5*24*time.Hour)) {
		t.Fatalf("trial = %+v, %v", trial, err)
	}

	_, u, err := f.svc.Authenticate(ctx, sess.Token)
	if err != nil || u.ID != sess.User.ID {
		t.Fatalf("authenticate = %+v, %v", u, err)
	}

	// A code works once.
	if _, err := f.svc.Verify(ctx, "ana@example.com", code, "machine-1"); !errors.Is(err, ErrInvalidCode) {
		t.Errorf("reused code err = %v", err)
	}

	if err := f.svc.SignOut(ctx, sess.Token); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.svc.Authenticate(ctx, sess.Token); !errors.Is(err, ErrInvalidToken) {
		t.Errorf("token after sign-out err = %v", err)
	}
}

func TestVerifyFailures(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name string
		run  func(f *fixture) error
		want error
	}{
		{"no code requested", func(f *fixture) error {
			_, err := f.svc.Verify(ctx, "ana@example.com", "123456", "m")
			return err
		}, ErrInvalidCode},
		{"malformed code", func(f *fixture) error {
			_ = f.svc.Start(ctx, "ana@example.com")
			_, err := f.svc.Verify(ctx, "ana@example.com", "12ab56", "m")
			return err
		}, ErrInvalidCode},
		{"expired", func(f *fixture) error {
			_ = f.svc.Start(ctx, "ana@example.com")
			f.now = f.now.Add(11 * time.Minute)
			_, err := f.svc.Verify(ctx, "ana@example.com", f.inbox.codes["ana@example.com"], "m")
			return err
		}, ErrCodeExpired},
		{"too many wrong guesses locks the code", func(f *fixture) error {
			_ = f.svc.Start(ctx, "ana@example.com")
			good := f.inbox.codes["ana@example.com"]
			bad := "000000"
			if good == bad {
				bad = "111111"
			}
			for range 5 {
				_, _ = f.svc.Verify(ctx, "ana@example.com", bad, "m")
			}
			_, err := f.svc.Verify(ctx, "ana@example.com", good, "m")
			return err
		}, ErrTooManyAttempts},
		{"only the newest code works", func(f *fixture) error {
			_ = f.svc.Start(ctx, "ana@example.com")
			first := f.inbox.codes["ana@example.com"]
			_ = f.svc.Start(ctx, "ana@example.com")
			if f.inbox.codes["ana@example.com"] == first {
				return ErrInvalidCode // astronomically unlikely collision
			}
			_, err := f.svc.Verify(ctx, "ana@example.com", first, "m")
			return err
		}, ErrInvalidCode},
		{"rate limited", func(f *fixture) error {
			for range 5 {
				if err := f.svc.Start(ctx, "ana@example.com"); err != nil {
					return err
				}
			}
			return f.svc.Start(ctx, "ana@example.com")
		}, ErrTooManyCodes},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := tt.run(setup(t)); !errors.Is(err, tt.want) {
				t.Errorf("err = %v, want %v", err, tt.want)
			}
		})
	}
}

func TestOneTrialPerComputer(t *testing.T) {
	ctx := context.Background()
	f := setup(t)
	signIn := func(email, machine string) Session {
		t.Helper()
		if err := f.svc.Start(ctx, email); err != nil {
			t.Fatal(err)
		}
		s, err := f.svc.Verify(ctx, email, f.inbox.codes[email], machine)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	if s := signIn("ana@example.com", "machine-1"); s.TrialDenied {
		t.Fatal("first account denied a trial")
	}
	if s := signIn("ana+2@example.com", "machine-1"); !s.TrialDenied {
		t.Fatal("second account on the same computer got another trial")
	}
	if s := signIn("bob@example.com", "machine-2"); s.TrialDenied {
		t.Fatal("a different computer was denied")
	}
}

func TestMachineHashIsKeyed(t *testing.T) {
	a := New(nil, nil, nil, []byte("k1")).MachineHash("abc")
	b := New(nil, nil, nil, []byte("k2")).MachineHash("abc")
	if string(a) == string(b) {
		t.Fatal("machine hash does not depend on the secret")
	}
}

func TestStartReportsMailFailures(t *testing.T) {
	f := setup(t)
	f.inbox.fail = errors.New("smtp down")
	if err := f.svc.Start(context.Background(), "ana@example.com"); err == nil {
		t.Fatal("expected mail error")
	}
}

func TestAuthenticateRejectsJunk(t *testing.T) {
	f := setup(t)
	for _, tok := range []string{"", "Bearer x", "fml_nope"} {
		if _, _, err := f.svc.Authenticate(context.Background(), tok); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("Authenticate(%q) err = %v", tok, err)
		}
	}
}
