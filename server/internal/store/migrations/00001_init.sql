-- +goose Up
CREATE TABLE users (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email       text NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
    id          bigserial PRIMARY KEY,
    email       text NOT NULL,
    code_hash   bytea NOT NULL,
    expires_at  timestamptz NOT NULL,
    attempts    int NOT NULL DEFAULT 0,
    consumed_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_email_created ON otp_codes (email, created_at DESC);

CREATE TABLE devices (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash    bytea NOT NULL UNIQUE,
    machine_hash  bytea NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz
);

-- One trial per account and one per machine.
CREATE TABLE trials (
    user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    machine_hash  bytea NOT NULL UNIQUE,
    started_at    timestamptz NOT NULL,
    ends_at       timestamptz NOT NULL
);

CREATE TABLE subscriptions (
    ls_id                text PRIMARY KEY,
    user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status               text NOT NULL,
    customer_id          text NOT NULL DEFAULT '',
    renews_at            timestamptz,
    ends_at              timestamptz,
    current_period_start timestamptz NOT NULL,
    updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user ON subscriptions (user_id, updated_at DESC);

CREATE TABLE usage (
    id            bigserial PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    model         text NOT NULL,
    input_tokens  bigint NOT NULL,
    output_tokens bigint NOT NULL,
    cache_read    bigint NOT NULL,
    cache_write   bigint NOT NULL,
    cost_micros   bigint NOT NULL,
    estimated     boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_user_created ON usage (user_id, created_at);

-- Worst-case holds for in-flight requests, so concurrent calls can't overspend.
CREATE TABLE reservations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    amount      bigint NOT NULL,
    expires_at  timestamptz NOT NULL
);
CREATE INDEX reservations_user ON reservations (user_id);

CREATE TABLE webhook_events (
    body_hash    bytea PRIMARY KEY,
    received_at  timestamptz NOT NULL DEFAULT now()
);

-- +goose Down
DROP TABLE webhook_events;
DROP TABLE reservations;
DROP TABLE usage;
DROP TABLE subscriptions;
DROP TABLE trials;
DROP TABLE devices;
DROP TABLE otp_codes;
DROP TABLE users;
