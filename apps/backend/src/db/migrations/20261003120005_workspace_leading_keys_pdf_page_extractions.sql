SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX pdf_page_extractions_pkey_ws ON pdf_page_extractions (workspace_id, id);
CREATE UNIQUE INDEX pdf_page_extractions_attachment_id_page_number_key_ws ON pdf_page_extractions (workspace_id, attachment_id, page_number);
