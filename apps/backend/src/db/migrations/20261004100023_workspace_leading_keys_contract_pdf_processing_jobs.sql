SET LOCAL lock_timeout = '5s';

ALTER TABLE pdf_processing_jobs DROP CONSTRAINT pdf_processing_jobs_attachment_id_key, ADD CONSTRAINT pdf_processing_jobs_attachment_id_key UNIQUE USING INDEX pdf_processing_jobs_attachment_id_key_ws;
