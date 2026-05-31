-- E2E-encrypted attachments: the bytes in S3 are client-side AES-GCM ciphertext.
--
-- The server holds opaque ciphertext + this flag + routing columns only. The
-- per-attachment decryption key, IV, and the real filename/mime/size live inside
-- the SSK-sealed message payload (attachmentRefs) and never reach the server, so
-- there is deliberately NO key/iv column here. The row's filename/mime_type are
-- placeholders for E2E uploads; size_bytes is the (unavoidable) ciphertext size.
--
-- e2e_only gates the upload pipeline: E2E uploads skip the malware scan (it can't
-- read ciphertext) and emit no attachment:uploaded event, so no processor
-- (captioning, PDF/Excel/Word/text extraction, video transcode, embedding) runs.
ALTER TABLE attachments
  ADD COLUMN e2e_only BOOLEAN NOT NULL DEFAULT FALSE;
