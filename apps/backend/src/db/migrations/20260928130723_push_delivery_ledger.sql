-- Durable per-device push delivery: workflow state (INV-57) for activity,
-- saved-reminder and rewrap-nudge pushes, plus integer generations that let a
-- delayed retry prove its subscription/reminder is still the one it planned for.
-- Generations are trigger-owned so replicas running the previous build (which
-- never write these columns) still bump them during the rolling deploy.

ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION bump_push_subscription_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.generation := OLD.generation + CASE
    WHEN (OLD.workspace_id, OLD.user_id, OLD.endpoint, OLD.p256dh, OLD.auth, OLD.device_key)
      IS DISTINCT FROM (NEW.workspace_id, NEW.user_id, NEW.endpoint, NEW.p256dh, NEW.auth, NEW.device_key)
    THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bump_push_subscription_generation ON push_subscriptions;
CREATE TRIGGER bump_push_subscription_generation
BEFORE UPDATE ON push_subscriptions
FOR EACH ROW
EXECUTE FUNCTION bump_push_subscription_generation();

ALTER TABLE saved_messages ADD COLUMN IF NOT EXISTS reminder_generation INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION bump_saved_reminder_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.reminder_generation := OLD.reminder_generation + CASE
    WHEN (OLD.status, OLD.remind_at, OLD.reminder_sent_at, OLD.reminder_queue_message_id)
      IS DISTINCT FROM (NEW.status, NEW.remind_at, NEW.reminder_sent_at, NEW.reminder_queue_message_id)
    THEN 1 ELSE 0 END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bump_saved_reminder_generation ON saved_messages;
CREATE TRIGGER bump_saved_reminder_generation
BEFORE UPDATE ON saved_messages
FOR EACH ROW
EXECUTE FUNCTION bump_saved_reminder_generation();

-- One plan per (source outbox event, recipient): a replayed event finds it and
-- plans nothing. Holds references only, never content or subscription keys.
CREATE TABLE IF NOT EXISTS push_delivery_plans (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  kind              TEXT NOT NULL,
  source_event_id   BIGINT NOT NULL,
  source_id         TEXT NOT NULL,
  source_generation INTEGER,
  source_created_at TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source_event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_push_delivery_plans_expires_at
  ON push_delivery_plans (expires_at);

-- One row per targeted device. `version` is the claim/lease identity: every
-- claim and every settle increments it, so a worker whose lease was taken over
-- can never settle the row.
CREATE TABLE IF NOT EXISTS push_deliveries (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL,
  plan_id                 TEXT NOT NULL,
  subscription_id         TEXT NOT NULL,
  subscription_generation INTEGER NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'pending',
  attempts                INTEGER NOT NULL DEFAULT 0,
  version                 INTEGER NOT NULL DEFAULT 0,
  lease_expires_at        TIMESTAMPTZ,
  next_attempt_at         TIMESTAMPTZ,
  last_outcome            TEXT,
  last_status_code        INTEGER,
  terminal_reason         TEXT,
  accepted_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plan_id, subscription_id)
);
