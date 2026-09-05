-- Enqueue the conversation-embeddings backfill for every workspace (INV-67).
-- The 15 minute delay lets old-code replicas cut over before the plan job is
-- claimed; a replica without the registered definition would dead-letter it.
INSERT INTO queue_messages (id, queue_name, workspace_id, payload, process_after, inserted_at)
SELECT
  'queue_' || replace(gen_random_uuid()::text, '-', ''),
  'backfill.plan',
  w.id,
  jsonb_build_object('workspaceId', w.id, 'backfillName', 'conversation-embeddings'),
  NOW() + INTERVAL '15 minutes',
  NOW()
FROM workspaces w;
