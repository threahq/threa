-- Source message ids whose exposure the author confirmed when scheduling.
ALTER TABLE scheduled_messages
ADD COLUMN IF NOT EXISTS consented_share_source_ids TEXT[] NOT NULL DEFAULT '{}';
