SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX pdf_processing_jobs_attachment_id_key_ws ON pdf_processing_jobs (workspace_id, attachment_id);
