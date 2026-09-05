-- Enqueue the message-language backfill for every workspace (INV-67): fills
-- messages.language for rows written before the column existed, which moves
-- their search_vector onto the stemmer for their own language. The 15 minute
-- delay lets old-code replicas cut over before the plan job is claimed; a
-- replica without the registered definition would dead-letter it.
INSERT INTO queue_messages (id, queue_name, workspace_id, payload, process_after, inserted_at)
SELECT
  'queue_' || replace(gen_random_uuid()::text, '-', ''),
  'backfill.plan',
  w.id,
  jsonb_build_object('workspaceId', w.id, 'backfillName', 'message-language'),
  NOW() + INTERVAL '15 minutes',
  NOW()
FROM workspaces w;
