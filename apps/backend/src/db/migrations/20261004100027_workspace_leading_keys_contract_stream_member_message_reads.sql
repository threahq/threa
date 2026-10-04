SET LOCAL lock_timeout = '5s';

ALTER TABLE stream_member_message_reads DROP CONSTRAINT stream_member_message_reads_pkey, ADD CONSTRAINT stream_member_message_reads_pkey PRIMARY KEY USING INDEX stream_member_message_reads_pkey_ws;
