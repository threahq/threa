-- Personal bots can opt in to reading everything their owner can read
-- (participation stays gated by bot_channel_access). Personal-only; code
-- validates shared bots never carry TRUE.

ALTER TABLE bots
ADD COLUMN IF NOT EXISTS reads_as_owner BOOLEAN NOT NULL DEFAULT FALSE;
