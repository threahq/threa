-- Add title provenance and monotonic revisions for rollout-safe naming writes.
ALTER TABLE streams
  ADD COLUMN display_name_source TEXT,
  ADD COLUMN display_name_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN display_name_updated_by_user_id TEXT;

ALTER TABLE conversations
  ADD COLUMN topic_summary_source TEXT,
  ADD COLUMN topic_summary_revision INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN topic_summary_updated_by_user_id TEXT;

UPDATE streams s
SET display_name_source = 'legacy'
WHERE s.display_name IS NOT NULL
   OR EXISTS (
     SELECT 1 FROM e2e_streams e
     WHERE e.workspace_id = s.workspace_id
       AND e.stream_id = s.id
       AND e.name_ciphertext IS NOT NULL
   );

UPDATE conversations
SET topic_summary_source = 'legacy'
WHERE topic_summary IS NOT NULL;

-- Sealed E2E titles are authoritative. Remove the historical plaintext copy
-- after provenance is captured so no later projection can expose it.
UPDATE streams s
SET display_name = NULL
WHERE EXISTS (
  SELECT 1 FROM e2e_streams e
  WHERE e.workspace_id = s.workspace_id
    AND e.stream_id = s.id
    AND e.name_ciphertext IS NOT NULL
);

-- One rollout-window compatibility fence: a pre-migration replica updates only
-- the old title column. Conservatively classify such writes as explicit and
-- advance the revision; new writers advance the revision themselves and pass
-- through unchanged. PR8 removes these after fleet soak.
CREATE FUNCTION preserve_legacy_stream_title_intent() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.display_name IS NOT NULL AND NEW.display_name_source IS NULL THEN
      NEW.display_name_source := 'explicit';
      NEW.display_name_revision := GREATEST(NEW.display_name_revision, 1);
    END IF;
  ELSIF NEW.display_name IS DISTINCT FROM OLD.display_name
    AND NEW.display_name_revision = OLD.display_name_revision THEN
    NEW.display_name_source := 'explicit';
    NEW.display_name_revision := OLD.display_name_revision + 1;
    NEW.display_name_updated_by_user_id := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER preserve_legacy_stream_title_intent_trigger
BEFORE INSERT OR UPDATE OF display_name ON streams
FOR EACH ROW EXECUTE FUNCTION preserve_legacy_stream_title_intent();

CREATE FUNCTION preserve_legacy_conversation_title_intent() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.topic_summary IS NOT NULL AND NEW.topic_summary_source IS NULL THEN
      NEW.topic_summary_source := 'explicit';
      NEW.topic_summary_revision := GREATEST(NEW.topic_summary_revision, 1);
    END IF;
  ELSIF NEW.topic_summary IS DISTINCT FROM OLD.topic_summary
    AND NEW.topic_summary_revision = OLD.topic_summary_revision THEN
    NEW.topic_summary_source := 'explicit';
    NEW.topic_summary_revision := OLD.topic_summary_revision + 1;
    NEW.topic_summary_updated_by_user_id := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER preserve_legacy_conversation_title_intent_trigger
BEFORE INSERT OR UPDATE OF topic_summary ON conversations
FOR EACH ROW EXECUTE FUNCTION preserve_legacy_conversation_title_intent();

-- Old replicas write sealed title bytes directly on e2e_streams and cannot
-- advance the new streams provenance columns. Treat those rollout-window writes
-- as explicit. New repository writes set a statement-local guard and coordinate
-- provenance themselves in the same transaction.
CREATE FUNCTION preserve_legacy_e2e_title_intent() RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('threa.coordinated_title_write', true) = '1' THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.name_ciphertext IS NOT NULL)
    OR (TG_OP = 'UPDATE' AND NEW.name_ciphertext IS DISTINCT FROM OLD.name_ciphertext) THEN
    UPDATE streams
    SET display_name_source = 'explicit',
        display_name_revision = display_name_revision + 1,
        display_name_updated_by_user_id = NULL
    WHERE workspace_id = NEW.workspace_id AND id = NEW.stream_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER preserve_legacy_e2e_title_intent_trigger
AFTER INSERT OR UPDATE OF name_ciphertext ON e2e_streams
FOR EACH ROW EXECUTE FUNCTION preserve_legacy_e2e_title_intent();
