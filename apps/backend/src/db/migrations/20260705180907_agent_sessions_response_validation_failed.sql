-- Mark supersede-rerun sessions whose final response repeatedly failed the
-- response validator (kept the previous reply instead of revising). The next
-- rerun that supersedes such a session escalates to the persona's
-- escalationModel (roadmap 2.3). Post-completion metadata of the session row
-- itself, like episode_summary -- a column, not a tracking table.

ALTER TABLE agent_sessions
ADD COLUMN IF NOT EXISTS response_validation_failed BOOLEAN NOT NULL DEFAULT FALSE;
