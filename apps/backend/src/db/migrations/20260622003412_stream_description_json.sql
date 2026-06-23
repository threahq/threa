-- Rich-text stream descriptions. `description_json` holds the canonical
-- ProseMirror document (mirrors messages' `content_json`); the existing
-- `description` TEXT column becomes the derived markdown projection that feeds
-- the `search_vector` generated column and the public-API wire format. Nullable
-- because a description is optional and `NULL` means "no rich description yet" —
-- legacy rows keep their plaintext `description` and render as markdown until
-- the first rich edit populates this column. No DB enum / JSON validation here
-- (INV-3); the shape is validated in app code against `threaDocumentSchema`.
ALTER TABLE streams
  ADD COLUMN description_json JSONB;
