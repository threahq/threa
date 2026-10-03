SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX video_transcode_jobs_attachment_id_key_ws ON video_transcode_jobs (workspace_id, attachment_id);
