package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Postgres is the production Store.
type Postgres struct {
	pool *pgxpool.Pool
}

// Open connects and applies migrations.
func Open(ctx context.Context, url string) (*Postgres, error) {
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to reach database: %w", err)
	}
	if err := migrate(ctx, pool); err != nil {
		pool.Close()
		return nil, err
	}
	return &Postgres{pool: pool}, nil
}

func migrate(ctx context.Context, pool *pgxpool.Pool) error {
	db := stdlib.OpenDBFromPool(pool)
	defer db.Close()
	goose.SetBaseFS(migrations)
	goose.SetLogger(goose.NopLogger())
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("failed to set migration dialect: %w", err)
	}
	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		return fmt.Errorf("failed to migrate database: %w", err)
	}
	return nil
}

func (p *Postgres) Close() { p.pool.Close() }

// Ping reports whether the database answers, for health checks.
func (p *Postgres) Ping(ctx context.Context) error { return p.pool.Ping(ctx) }

func notFound(err error) error {
	if errors.Is(err, pgx.ErrNoRows) || errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func (p *Postgres) CreateOTP(ctx context.Context, email string, codeHash []byte, expiresAt time.Time) error {
	_, err := p.pool.Exec(ctx, `INSERT INTO otp_codes (email, code_hash, expires_at) VALUES ($1, $2, $3)`, email, codeHash, expiresAt)
	if err != nil {
		return fmt.Errorf("failed to store code: %w", err)
	}
	return nil
}

func (p *Postgres) LatestOTP(ctx context.Context, email string) (OTP, error) {
	var o OTP
	err := p.pool.QueryRow(ctx, `SELECT id, email, code_hash, expires_at, attempts, consumed_at, created_at
		FROM otp_codes WHERE email = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, email).
		Scan(&o.ID, &o.Email, &o.CodeHash, &o.ExpiresAt, &o.Attempts, &o.ConsumedAt, &o.CreatedAt)
	if err != nil {
		return OTP{}, notFound(err)
	}
	return o, nil
}

func (p *Postgres) BumpOTPAttempts(ctx context.Context, id int64) (int, error) {
	var n int
	err := p.pool.QueryRow(ctx, `UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`, id).Scan(&n)
	if err != nil {
		return 0, notFound(err)
	}
	return n, nil
}

func (p *Postgres) ConsumeOTP(ctx context.Context, id int64) error {
	tag, err := p.pool.Exec(ctx, `UPDATE otp_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL`, id)
	if err != nil {
		return fmt.Errorf("failed to consume code: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (p *Postgres) CountOTPsSince(ctx context.Context, email string, since time.Time) (int, error) {
	var n int
	if err := p.pool.QueryRow(ctx, `SELECT count(*) FROM otp_codes WHERE email = $1 AND created_at >= $2`, email, since).Scan(&n); err != nil {
		return 0, fmt.Errorf("failed to count codes: %w", err)
	}
	return n, nil
}

func (p *Postgres) UpsertUser(ctx context.Context, email string) (User, error) {
	var u User
	err := p.pool.QueryRow(ctx, `INSERT INTO users (email) VALUES ($1)
		ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
		RETURNING id, email, created_at`, email).Scan(&u.ID, &u.Email, &u.CreatedAt)
	if err != nil {
		return User{}, fmt.Errorf("failed to upsert user: %w", err)
	}
	return u, nil
}

func (p *Postgres) UserByID(ctx context.Context, id string) (User, error) {
	var u User
	err := p.pool.QueryRow(ctx, `SELECT id, email, created_at FROM users WHERE id = $1`, id).Scan(&u.ID, &u.Email, &u.CreatedAt)
	if err != nil {
		return User{}, notFound(err)
	}
	return u, nil
}

func (p *Postgres) CreateDevice(ctx context.Context, userID string, tokenHash, machineHash []byte) (Device, error) {
	d := Device{UserID: userID, MachineHash: machineHash}
	err := p.pool.QueryRow(ctx, `INSERT INTO devices (user_id, token_hash, machine_hash) VALUES ($1, $2, $3)
		RETURNING id, created_at, last_seen_at`, userID, tokenHash, machineHash).Scan(&d.ID, &d.CreatedAt, &d.LastSeenAt)
	if err != nil {
		return Device{}, fmt.Errorf("failed to create device: %w", err)
	}
	return d, nil
}

func (p *Postgres) DeviceByToken(ctx context.Context, tokenHash []byte) (Device, User, error) {
	var d Device
	var u User
	err := p.pool.QueryRow(ctx, `UPDATE devices d SET last_seen_at = now()
		FROM users u
		WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND u.id = d.user_id
		RETURNING d.id, d.user_id, d.machine_hash, d.created_at, d.last_seen_at, u.id, u.email, u.created_at`, tokenHash).
		Scan(&d.ID, &d.UserID, &d.MachineHash, &d.CreatedAt, &d.LastSeenAt, &u.ID, &u.Email, &u.CreatedAt)
	if err != nil {
		return Device{}, User{}, notFound(err)
	}
	return d, u, nil
}

func (p *Postgres) RevokeDevice(ctx context.Context, tokenHash []byte) error {
	if _, err := p.pool.Exec(ctx, `UPDATE devices SET revoked_at = now() WHERE token_hash = $1`, tokenHash); err != nil {
		return fmt.Errorf("failed to revoke device: %w", err)
	}
	return nil
}

func (p *Postgres) StartTrial(ctx context.Context, userID string, machineHash []byte, start time.Time, length time.Duration) (Trial, error) {
	if t, err := p.TrialFor(ctx, userID); err == nil {
		return t, nil
	} else if !errors.Is(err, ErrNotFound) {
		return Trial{}, err
	}
	t := Trial{UserID: userID, StartedAt: start, EndsAt: start.Add(length)}
	_, err := p.pool.Exec(ctx, `INSERT INTO trials (user_id, machine_hash, started_at, ends_at) VALUES ($1, $2, $3, $4)`,
		userID, machineHash, t.StartedAt, t.EndsAt)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		// A concurrent verify for the same user won; otherwise the machine is taken.
		if existing, err := p.TrialFor(ctx, userID); err == nil {
			return existing, nil
		}
		return Trial{}, ErrTrialUsed
	}
	if err != nil {
		return Trial{}, fmt.Errorf("failed to start trial: %w", err)
	}
	return t, nil
}

func (p *Postgres) TrialFor(ctx context.Context, userID string) (Trial, error) {
	var t Trial
	err := p.pool.QueryRow(ctx, `SELECT user_id, started_at, ends_at FROM trials WHERE user_id = $1`, userID).Scan(&t.UserID, &t.StartedAt, &t.EndsAt)
	if err != nil {
		return Trial{}, notFound(err)
	}
	return t, nil
}

func (p *Postgres) UpsertSubscription(ctx context.Context, s Subscription) error {
	var start any = s.CurrentPeriodStart
	if s.CurrentPeriodStart.IsZero() {
		start = nil
	}
	_, err := p.pool.Exec(ctx, `INSERT INTO subscriptions (ls_id, user_id, status, customer_id, renews_at, ends_at, current_period_start, ls_updated_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), $8, now())
		ON CONFLICT (ls_id) DO UPDATE SET
			status = EXCLUDED.status,
			customer_id = EXCLUDED.customer_id,
			renews_at = EXCLUDED.renews_at,
			ends_at = EXCLUDED.ends_at,
			current_period_start = COALESCE($7, subscriptions.current_period_start),
			ls_updated_at = COALESCE(EXCLUDED.ls_updated_at, subscriptions.ls_updated_at),
			updated_at = now()
		WHERE subscriptions.ls_updated_at IS NULL OR EXCLUDED.ls_updated_at IS NULL
			OR EXCLUDED.ls_updated_at >= subscriptions.ls_updated_at`,
		s.LSID, s.UserID, s.Status, s.CustomerID, s.RenewsAt, s.EndsAt, start, s.LSUpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to save subscription: %w", err)
	}
	return nil
}

const subColumns = `ls_id, user_id, status, customer_id, renews_at, ends_at, current_period_start, ls_updated_at, updated_at`

func scanSub(row pgx.Row) (Subscription, error) {
	var s Subscription
	if err := row.Scan(&s.LSID, &s.UserID, &s.Status, &s.CustomerID, &s.RenewsAt, &s.EndsAt, &s.CurrentPeriodStart, &s.LSUpdatedAt, &s.UpdatedAt); err != nil {
		return Subscription{}, notFound(err)
	}
	return s, nil
}

func (p *Postgres) SubscriptionFor(ctx context.Context, userID string) (Subscription, error) {
	return scanSub(p.pool.QueryRow(ctx, `SELECT `+subColumns+` FROM subscriptions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`, userID))
}

func (p *Postgres) SubscriptionByLSID(ctx context.Context, lsID string) (Subscription, error) {
	return scanSub(p.pool.QueryRow(ctx, `SELECT `+subColumns+` FROM subscriptions WHERE ls_id = $1`, lsID))
}

func (p *Postgres) SetPeriodStart(ctx context.Context, lsID string, t time.Time) error {
	tag, err := p.pool.Exec(ctx, `UPDATE subscriptions SET current_period_start = $2 WHERE ls_id = $1`, lsID, t)
	if err != nil {
		return fmt.Errorf("failed to set billing period: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// Reserve atomically checks spent + held + amount against the budget. The
// user row lock serializes concurrent requests from the same account.
func (p *Postgres) Reserve(ctx context.Context, h Hold) (string, bool, error) {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return "", false, fmt.Errorf("failed to begin reservation: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit

	if _, err := tx.Exec(ctx, `SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, h.UserID); err != nil {
		return "", false, fmt.Errorf("failed to lock account: %w", err)
	}
	if _, err := tx.Exec(ctx, `DELETE FROM reservations WHERE user_id = $1 AND expires_at <= now()`, h.UserID); err != nil {
		return "", false, fmt.Errorf("failed to clear stale holds: %w", err)
	}
	var spent, held int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(cost_micros), 0) FROM usage WHERE user_id = $1 AND created_at >= $2`, h.UserID, h.PeriodStart).Scan(&spent); err != nil {
		return "", false, fmt.Errorf("failed to sum usage: %w", err)
	}
	if err := tx.QueryRow(ctx, `SELECT COALESCE(sum(amount), 0) FROM reservations WHERE user_id = $1`, h.UserID).Scan(&held); err != nil {
		return "", false, fmt.Errorf("failed to sum holds: %w", err)
	}
	if spent+held+h.Amount > h.Budget {
		return "", false, nil
	}
	var id string
	if err := tx.QueryRow(ctx, `INSERT INTO reservations (user_id, amount, expires_at) VALUES ($1, $2, $3) RETURNING id`, h.UserID, h.Amount, h.ExpiresAt).Scan(&id); err != nil {
		return "", false, fmt.Errorf("failed to reserve: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, fmt.Errorf("failed to commit reservation: %w", err)
	}
	return id, true, nil
}

func insertUsage(ctx context.Context, q interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, rec UsageRecord) error {
	created := rec.CreatedAt
	if created.IsZero() {
		created = time.Now()
	}
	_, err := q.Exec(ctx, `INSERT INTO usage (user_id, model, input_tokens, output_tokens, cache_read, cache_write, cost_micros, estimated, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
		rec.UserID, rec.Model, rec.Input, rec.Output, rec.CacheRead, rec.CacheWrite, rec.CostMicros, rec.Estimated, created)
	if err != nil {
		return fmt.Errorf("failed to record usage: %w", err)
	}
	return nil
}

func (p *Postgres) Settle(ctx context.Context, reservationID string, rec UsageRecord) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("failed to begin settle: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after commit
	if _, err := tx.Exec(ctx, `DELETE FROM reservations WHERE id = $1`, reservationID); err != nil {
		return fmt.Errorf("failed to release hold: %w", err)
	}
	if err := insertUsage(ctx, tx, rec); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("failed to commit settle: %w", err)
	}
	return nil
}

func (p *Postgres) Release(ctx context.Context, reservationID string) error {
	if _, err := p.pool.Exec(ctx, `DELETE FROM reservations WHERE id = $1`, reservationID); err != nil {
		return fmt.Errorf("failed to release hold: %w", err)
	}
	return nil
}

func (p *Postgres) RecordUsage(ctx context.Context, rec UsageRecord) error {
	return insertUsage(ctx, p.pool, rec)
}

func (p *Postgres) SpentSince(ctx context.Context, userID string, since time.Time) (int64, error) {
	var n int64
	if err := p.pool.QueryRow(ctx, `SELECT COALESCE(sum(cost_micros), 0) FROM usage WHERE user_id = $1 AND created_at >= $2`, userID, since).Scan(&n); err != nil {
		return 0, fmt.Errorf("failed to sum usage: %w", err)
	}
	return n, nil
}

func (p *Postgres) RequestsSince(ctx context.Context, userID string, since time.Time) (int, error) {
	var n int
	if err := p.pool.QueryRow(ctx, `SELECT count(*) FROM usage WHERE user_id = $1 AND created_at >= $2`, userID, since).Scan(&n); err != nil {
		return 0, fmt.Errorf("failed to count requests: %w", err)
	}
	return n, nil
}

func (p *Postgres) FirstSeen(ctx context.Context, bodyHash []byte) (bool, error) {
	tag, err := p.pool.Exec(ctx, `INSERT INTO webhook_events (body_hash) VALUES ($1) ON CONFLICT DO NOTHING`, bodyHash)
	if err != nil {
		return false, fmt.Errorf("failed to record webhook: %w", err)
	}
	return tag.RowsAffected() == 1, nil
}

// Reset wipes all data; for tests only.
func (p *Postgres) Reset(ctx context.Context) error {
	_, err := p.pool.Exec(ctx, `TRUNCATE webhook_events, reservations, usage, subscriptions, trials, devices, otp_codes, users CASCADE`)
	if err != nil {
		return fmt.Errorf("failed to reset: %w", err)
	}
	return nil
}
