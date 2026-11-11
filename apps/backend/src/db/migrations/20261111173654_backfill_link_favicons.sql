-- Enqueue the link-favicons backfill for every workspace with a fetched favicon (INV-67).
-- The 15 minute delay lets old-code replicas cut over before a plan job is
-- claimed; a replica without the registered definition would dead-letter it.
INSERT INTO queue_messages (id, queue_name, workspace_id, payload, process_after, inserted_at)
SELECT
  'queue_' || replace(gen_random_uuid()::text, '-', ''),
  'backfill.plan',
  w.id,
  jsonb_build_object('workspaceId', w.id, 'backfillName', 'link-favicons'),
  NOW() + INTERVAL '15 minutes',
  NOW()
FROM workspaces w
WHERE EXISTS (
  SELECT 1 FROM link_previews lp
  WHERE lp.workspace_id = w.id AND lp.status = 'completed' AND lp.favicon_url IS NOT NULL
);
