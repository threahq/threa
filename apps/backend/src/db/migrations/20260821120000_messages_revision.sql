-- Revision 1 is the original body; every edit adds one. The number was until now
-- derived as MAX(message_versions.version_number) + 1, which cannot be pinned by
-- a reference without a second query per message. Backfill reproduces that
-- derivation once, set-based, so historical rows agree with it.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;

UPDATE messages m
SET revision = v.max_version + 1
FROM (SELECT message_id, MAX(version_number) AS max_version FROM message_versions GROUP BY message_id) v
WHERE v.message_id = m.id;
