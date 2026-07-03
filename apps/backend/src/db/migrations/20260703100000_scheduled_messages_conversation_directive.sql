-- Carry a "Reply in conversation" directive through a scheduled send.
--
-- A scheduled message can be armed for a conversation the same way a live send
-- is (message-input's "Reply in conversation" strip is available in the same
-- composer as the schedule picker). We store the declared ConversationDirective
-- here so the fire path forwards it to EventService.createMessage — the delivered
-- message files into the conversation exactly as an immediate send would, instead
-- of silently landing flat in the channel.
--
-- Nullable: an ordinary scheduled send (no arm) leaves it NULL and the async
-- boundary-extractor infers the conversation at fire time, same as today. The
-- value is an opaque directive object ({ intent, conversationId? }) validated at
-- write time by the same wire schema the live-send path uses; the assigner
-- re-validates access at fire time. Not a foreign key (INV-1), not indexed
-- (read only as part of a row already fetched by id at fire time).

ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS conversation_directive JSONB;
