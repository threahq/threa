-- Encrypted scratchpads used to have companion_mode force-set to 'off' at
-- creation while Ariadne replied anyway through the enclave -- the Companion/
-- Quiet toggle "lied". Companion mode now genuinely gates the enclave
-- auto-reply (EnclaveDispatchHandler). Preserve current behavior for existing
-- encrypted scratchpads that have the enclave invited by flipping their stored
-- 'off' to 'on', so Ariadne keeps replying where she already does; owners who
-- want a silent encrypted dump can switch to Quiet, which now actually works.
UPDATE streams s
SET companion_mode = 'on'
WHERE s.companion_mode = 'off'
  AND EXISTS (SELECT 1 FROM e2e_streams e WHERE e.stream_id = s.id)
  AND EXISTS (
    SELECT 1 FROM e2e_stream_actors a
    WHERE a.stream_id = s.id AND a.kind = 'enclave'
  );
