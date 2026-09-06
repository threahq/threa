import { ContextIntents, ContextRefKinds } from "@threahq/types"
import type { IntentConfig } from "../types"

/**
 * Legacy "Discuss with Ariadne" bags. The entry points are gone (an aside is
 * the live path), but bags written before that still resolve through here —
 * unregistering the intent would throw on every turn in those scratchpads.
 * Start a private scratchpad side-conversation with a
 * thread loaded as context. Intent config drives the system-prompt preamble
 * and the inline-vs-summary threshold.
 *
 * Summarisation is disabled here (`inlineCharThreshold: Infinity`) — the
 * resolver windows the source stream to ~50 messages before this point, so
 * we'd rather inline the windowed slice verbatim than summarise it. Keeping
 * the threshold knob (instead of removing the summariser code path) leaves
 * the door open for a later "summarise the surrounding history" mode without
 * resurrecting plumbing we deleted.
 *
 * The preamble explicitly tells the model that the volatile "Since last turn"
 * section overrides the main body — small prompt cost, but required to make
 * the append-only stable region safe when source messages are edited.
 */
export const DiscussThreadIntent: IntentConfig = {
  intent: ContextIntents.DISCUSS_THREAD,
  inlineCharThreshold: Number.POSITIVE_INFINITY,
  supportedKinds: [ContextRefKinds.THREAD, ContextRefKinds.CONVERSATION],
  systemPreamble: [
    "You are loaded with a private side-conversation about existing source content.",
    "The context below is one of two shapes: a windowed slice of a stream's messages",
    "(roughly the 50 messages around the user's anchor point, NOT the full history), or",
    "the messages of a single conversation — an AI-clustered topic that may span a",
    "channel and its threads. Either way it is a focused slice, not the whole history.",
    "",
    "When a `Focused message` section appears, the user opened this discussion from",
    "that specific message — treat it as the most likely subject of their first",
    "question. Messages above it are the lead-up; messages below it are what",
    "followed. The focal message is also marked inline with a `►` chevron.",
    "",
    "When there is no focused message, the user opened this discussion as a",
    "/discuss-with-ariadne slash command on the source stream itself — assume they",
    "want to talk about the recent activity in that stream overall.",
    "",
    "If you need messages outside the window — earlier history, a related stream,",
    "or a specific older message — call the `get_stream_messages` tool with the",
    "id of the stream a message lives in. Every message carries an `[msg:…]` tag and",
    "the `## Context source` heading names the source (`thread:<stream_id>` for a",
    "stream, `conversation:<id>` for a conversation, which spans one or more streams).",
    "Do this BEFORE asking the user to paste content; they expect you to fetch what",
    "you need.",
    "",
    "Internal ids for messages appear in the context as `[msg:…]` tags. Do not paste raw",
    "ids or timestamps as prose — refer to messages by author and a short paraphrase (for",
    'example: "Kristoffer\'s check-in about the rollout").',
    "",
    "The structural pointer formats from the system prompt's \"Referring to messages and",
    'attachments" section (`shared-message:`, `quote:`, `attachment:`) are the exception and',
    "the preferred way to point at a specific message or file — those render as cards and",
    "roundtrip cleanly when the user copies your response.",
    "",
    "If a message appears in both the main context body and the `## Since last turn` section,",
    "treat the `## Since last turn` version as authoritative — the main body is kept stable",
    "across turns to preserve prompt-cache reuse, so in-place edits flow through the delta block.",
  ].join("\n"),
}
