SET LOCAL lock_timeout = '5s';

ALTER TABLE video_transcode_jobs DROP CONSTRAINT video_transcode_jobs_attachment_id_key, ADD CONSTRAINT video_transcode_jobs_attachment_id_key UNIQUE USING INDEX video_transcode_jobs_attachment_id_key_ws;
