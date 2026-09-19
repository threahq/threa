-- Sealed decision cards: a bot runtime on an end-to-end-encrypted scratchpad
-- asking its human a question the server cannot read.
--
-- Same split messages use: the NOT NULL projection columns (`title`,
-- `body_markdown`, and each option's `label` inside `options`) hold the
-- zero-width placeholder, and the real question is the ciphertext here, sealed
-- under the stream key and bound by AAD to
-- `streamId|decision|decisionId|requesterBotId`. Option *ids* and *tones* stay
-- readable in `options`: the server validates an answer against those ids, and
-- a card whose key is not loaded still renders its buttons.
--
-- The resolver's note rides in `resolution` as `noteCiphertext`/`noteEnvelope`
-- (AAD `streamId|decision-note|decisionId|decidedBy`), so no column changes for
-- it; `resolution` is already JSONB.
ALTER TABLE decision_requests
  ADD COLUMN IF NOT EXISTS ciphertext TEXT,
  ADD COLUMN IF NOT EXISTS envelope JSONB;
