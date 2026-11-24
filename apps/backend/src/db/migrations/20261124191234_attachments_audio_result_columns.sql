-- Audio processing results: normalized AAC object (NULL for passthrough codecs),
-- duration, and base64 waveform peaks. processing_status remains the state machine.

ALTER TABLE attachments ADD COLUMN IF NOT EXISTS normalized_audio_storage_path TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS waveform TEXT;
