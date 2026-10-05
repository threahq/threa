-- Threa Connect: when the share behind a partner's copy ends, the copy stays
-- readable but takes no more writes. NULL is a copy still shared, or a local stream.
ALTER TABLE streams ADD COLUMN disconnected_at TIMESTAMPTZ;
