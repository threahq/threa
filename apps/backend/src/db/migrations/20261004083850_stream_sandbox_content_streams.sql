-- The streams a sandbox's files may hold content from: every stream its
-- commands read through the API, and every attachment copied in. A turn that
-- cannot read all of them gets a fresh box, and each command's output carries
-- them as sources.
ALTER TABLE stream_sandboxes ADD COLUMN content_stream_ids TEXT[] NOT NULL DEFAULT '{}';
