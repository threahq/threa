-- Remove dynamic-naming rollout compatibility after all backend and enclave
-- replicas have moved to the revision-fenced lifecycle.

UPDATE queue_messages
SET
  cancelled_at = NOW(),
  process_after = NULL,
  claimed_at = NULL,
  claimed_by = NULL,
  claimed_until = NULL
WHERE queue_name = 'naming.generate'
  AND completed_at IS NULL
  AND cancelled_at IS NULL;

DELETE FROM queue_tokens
WHERE queue_name = 'naming.generate';

DROP TRIGGER IF EXISTS preserve_legacy_stream_title_intent_trigger ON streams;
DROP FUNCTION IF EXISTS preserve_legacy_stream_title_intent();

DROP TRIGGER IF EXISTS preserve_legacy_conversation_title_intent_trigger ON conversations;
DROP FUNCTION IF EXISTS preserve_legacy_conversation_title_intent();

DROP TRIGGER IF EXISTS preserve_legacy_e2e_title_intent_trigger ON e2e_streams;
DROP FUNCTION IF EXISTS preserve_legacy_e2e_title_intent();

-- `display_name_generated_at` stays for one more deploy window. PR8 code no
-- longer reads or writes it; dropping it in the same rolling deploy would break
-- still-running PR7 replicas that select the column.
