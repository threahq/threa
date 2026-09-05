-- Per-message language so full-text search stems each message with the
-- Postgres config for its own language instead of 'english' for everything
-- (a Swedish "fakturorna" never matched "faktura" under the English stemmer).
--
-- `language` holds the detector's ISO 639-1 code ('sv', 'en', ...), 'und'
-- when the text was too short or ambiguous to detect, NULL for rows written
-- before this column existed (the message-language backfill fills those).
-- Unknown, 'und' and NULL all resolve to 'english', so old code that never
-- sets the column keeps today's behaviour.
ALTER TABLE messages ADD COLUMN language TEXT;

-- IMMUTABLE so it can drive a STORED generated column. The language → config
-- table is mirrored by SEARCH_TEXT_CONFIGS in apps/backend/src/lib/text-language.ts,
-- which is the list the query side ORs across; keep the two in step.
CREATE FUNCTION search_config_for_language(lang TEXT) RETURNS regconfig
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE lang
    WHEN 'ar' THEN 'pg_catalog.arabic'::regconfig
    WHEN 'hy' THEN 'pg_catalog.armenian'::regconfig
    WHEN 'da' THEN 'pg_catalog.danish'::regconfig
    WHEN 'nl' THEN 'pg_catalog.dutch'::regconfig
    WHEN 'fi' THEN 'pg_catalog.finnish'::regconfig
    WHEN 'fr' THEN 'pg_catalog.french'::regconfig
    WHEN 'de' THEN 'pg_catalog.german'::regconfig
    WHEN 'el' THEN 'pg_catalog.greek'::regconfig
    WHEN 'hi' THEN 'pg_catalog.hindi'::regconfig
    WHEN 'hu' THEN 'pg_catalog.hungarian'::regconfig
    WHEN 'id' THEN 'pg_catalog.indonesian'::regconfig
    WHEN 'ga' THEN 'pg_catalog.irish'::regconfig
    WHEN 'it' THEN 'pg_catalog.italian'::regconfig
    WHEN 'lt' THEN 'pg_catalog.lithuanian'::regconfig
    WHEN 'no' THEN 'pg_catalog.norwegian'::regconfig
    WHEN 'pt' THEN 'pg_catalog.portuguese'::regconfig
    WHEN 'ro' THEN 'pg_catalog.romanian'::regconfig
    WHEN 'ru' THEN 'pg_catalog.russian'::regconfig
    WHEN 'sr' THEN 'pg_catalog.serbian'::regconfig
    WHEN 'es' THEN 'pg_catalog.spanish'::regconfig
    WHEN 'sv' THEN 'pg_catalog.swedish'::regconfig
    WHEN 'ta' THEN 'pg_catalog.tamil'::regconfig
    WHEN 'tr' THEN 'pg_catalog.turkish'::regconfig
    WHEN 'yi' THEN 'pg_catalog.yiddish'::regconfig
    ELSE 'pg_catalog.english'::regconfig
  END
$$;

-- A stored generated column cannot change expression in place; dropping it
-- also drops idx_messages_search. Both come back in one rewrite.
ALTER TABLE messages
  DROP COLUMN search_vector,
  ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector(search_config_for_language(language), content_markdown)) STORED;

CREATE INDEX idx_messages_search ON messages USING GIN (search_vector) WHERE deleted_at IS NULL;
