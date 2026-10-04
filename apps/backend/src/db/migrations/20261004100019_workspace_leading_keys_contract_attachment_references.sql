SET LOCAL lock_timeout = '5s';

ALTER TABLE attachment_references DROP CONSTRAINT attachment_references_pkey, ADD CONSTRAINT attachment_references_pkey PRIMARY KEY USING INDEX attachment_references_pkey_ws;

DROP INDEX attachment_references_pair_idx;
ALTER INDEX attachment_references_pair_idx_ws RENAME TO attachment_references_pair_idx;
