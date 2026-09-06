import { describe, expect, test } from "bun:test"
import { ContextIntents, ContextRefKinds } from "@threahq/types"
import { DiscussThreadIntent } from "./discuss-thread"
import { renderStable } from "../render"
import type { RenderableMessage } from "../types"

function msg(overrides: Partial<RenderableMessage>): RenderableMessage {
  return {
    messageId: "msg_a",
    authorId: "usr_1",
    authorName: "Alice",
    contentMarkdown: "hello",
    createdAt: "2026-04-22T09:00:00Z",
    editedAt: null,
    sequence: 1n,
    ...overrides,
  }
}

describe("DiscussThreadIntent config", () => {
  test("declares the intent and supported kinds expected by the registry", () => {
    expect(DiscussThreadIntent.intent).toBe(ContextIntents.DISCUSS_THREAD)
    expect(DiscussThreadIntent.supportedKinds).toContain(ContextRefKinds.THREAD)
  })

  test("disables summarisation by setting an infinite inline-char threshold", () => {
    // The resolver windows the source stream to ~50 messages before render,
    // so we'd rather inline that windowed slice verbatim than summarise it.
    // The summariser code path is intentionally kept around for future
    // intents — but it must stay dormant for DISCUSS_THREAD. Regression
    // guard: a finite threshold here would silently re-enable summarisation
    // for slices with long messages, the exact failure mode we just fixed.
    expect(DiscussThreadIntent.inlineCharThreshold).toBe(Number.POSITIVE_INFINITY)
  })

  test("system preamble instructs the model to treat the delta as authoritative", () => {
    expect(DiscussThreadIntent.systemPreamble).toContain("Since last turn")
    expect(DiscussThreadIntent.systemPreamble.toLowerCase()).toContain("authoritative")
  })

  test("system preamble forbids leaking internal ids to the user as raw prose", () => {
    // Regression for early behaviour where Ariadne copied `[msg_xyz]` into her
    // user-facing output. The preamble must frame raw ids as internal-only.
    expect(DiscussThreadIntent.systemPreamble.toLowerCase()).toContain("do not paste raw")
  })

  test("system preamble carves out the structural pointer formats as the exception", () => {
    // The "no raw ids" rule must not block `shared-message:`, `quote:`, or
    // `attachment:` pointer URLs — those are the supported way to reference a
    // specific message or file and roundtrip cleanly when the user copies the
    // response. Without this carve-out the model defaults to paraphrasing.
    const preamble = DiscussThreadIntent.systemPreamble
    expect(preamble).toContain("shared-message:")
    expect(preamble).toContain("quote:")
    expect(preamble).toContain("attachment:")
    expect(preamble).toContain("preferred way to point at")
  })
})

describe("inline-vs-summarize strategy (via renderStable)", () => {
  // The inline threshold is a soft size gate enforced in `resolveBagForStream`.
  // The intent config declares the gate; this test sanity-checks that the
  // renderer honors each branch — summary path when summaryText is supplied,
  // inline path otherwise.
  test("renders the summary text when the large-thread branch is taken", () => {
    const out = renderStable({
      preamble: DiscussThreadIntent.systemPreamble,
      summaryText: "A short summary [msg_a].",
      refLabel: "thread:stream_x",
    })
    expect(out).toContain("A short summary [msg_a]")
    expect(out).not.toContain("Messages (chronological)")
  })

  test("renders inline messages when the small-thread branch is taken", () => {
    const out = renderStable({
      preamble: DiscussThreadIntent.systemPreamble,
      inlineItems: [msg({})],
      refLabel: "thread:stream_x",
    })
    expect(out).toContain("Messages (chronological)")
    expect(out).toContain("[msg_a]")
  })

  test("splits inline messages around the focal anchor and marks it with a chevron", () => {
    // Render with an empty preamble so the assertion below isn't fooled by
    // the preamble's own mention of focal-message machinery — we want to
    // pin the *renderer's* output for this case.
    const out = renderStable({
      preamble: "",
      inlineItems: [
        msg({ messageId: "msg_a" }),
        msg({ messageId: "msg_b", contentMarkdown: "the focal one" }),
        msg({ messageId: "msg_c" }),
      ],
      refLabel: "thread:stream_x",
      focalMessageId: "msg_b",
    })
    expect(out).toContain("Messages before the focused message")
    expect(out).toContain("Focused message (the message the user opened this discussion from)")
    expect(out).toContain("Messages after the focused message")
    expect(out).toContain("► [msg_b]")
    // Without a focal we'd see the un-split heading; with a focal we should not.
    expect(out).not.toContain("Messages (chronological)")
  })

  test("falls back to the chronological list when the focal id isn't in the inline window", () => {
    // Empty preamble — see comment in the previous test for why.
    const out = renderStable({
      preamble: "",
      inlineItems: [msg({ messageId: "msg_a" }), msg({ messageId: "msg_b" })],
      refLabel: "thread:stream_x",
      // Caller asked for a focal that isn't present — render plain list rather
      // than fabricate a focal section the model will get confused by.
      focalMessageId: "msg_phantom",
    })
    expect(out).toContain("Messages (chronological)")
    expect(out).not.toContain("Focused message (the message the user opened this discussion from)")
  })
})
