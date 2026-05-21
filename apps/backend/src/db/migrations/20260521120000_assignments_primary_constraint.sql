-- =============================================================================
-- Conversation Message Assignments: deferred "exactly one primary" constraint
-- =============================================================================
--
-- The partial unique index `conversation_message_assignments_message_primary`
-- (added in the prior migration) enforces "AT MOST one primary per message" —
-- it cannot enforce "EXACTLY one." A row with is_primary=FALSE and no
-- corresponding TRUE row would slip through the partial index.
--
-- The application contract is stricter: every message that has any assignment
-- row must have exactly one primary. This migration adds a DEFERRED constraint
-- trigger so the invariant is checked at COMMIT, letting `assignPrimary`'s
-- two-step DELETE-then-UPSERT pattern (which transiently has zero primaries
-- mid-statement) and the service's "secondary first, then primary" loop
-- (which transiently has only secondaries mid-transaction) both work.
--
-- INV-20 race safety: under READ COMMITTED two concurrent transactions
-- targeting the same message both see "exactly one primary" at commit, so the
-- trigger does not cause spurious aborts.

BEGIN;

CREATE OR REPLACE FUNCTION cma_enforce_exactly_one_primary()
RETURNS TRIGGER AS $$
DECLARE
  affected_message_id TEXT;
  primary_count INT;
  total_count INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_message_id := OLD.message_id;
  ELSE
    affected_message_id := NEW.message_id;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE is_primary)::INT,
    COUNT(*)::INT
  INTO primary_count, total_count
  FROM conversation_message_assignments
  WHERE message_id = affected_message_id;

  -- Zero rows is fine (message has been fully un-assigned). Otherwise we
  -- require exactly one primary across the message's assignment set.
  IF total_count > 0 AND primary_count <> 1 THEN
    RAISE EXCEPTION
      'Message % must have exactly one primary assignment (found % across % rows)',
      affected_message_id, primary_count, total_count
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER cma_exactly_one_primary_per_message
AFTER INSERT OR UPDATE OR DELETE ON conversation_message_assignments
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION cma_enforce_exactly_one_primary();

COMMIT;
