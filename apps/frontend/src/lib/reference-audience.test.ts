import { describe, expect, it } from "vitest"
import type { JSONContent, ReferenceAudience } from "@threahq/types"
import {
  audienceQuestionCopy,
  collectComposerReferences,
  exposingAudiences,
  referenceStreamIds,
  resolveSendWarning,
  type ComposerReference,
  type SendWarning,
} from "./reference-audience"

const ORIGIN = window.location.origin

function audience(streamId: string, count: number): ReferenceAudience {
  return { streamId, count, sampleUserIds: [] }
}

function warning(tone: SendWarning["tone"], count: number, convertible: boolean): SendWarning {
  return {
    tone,
    lead: audience("stream_a", count),
    exposed: { reveal: tone === "reveal" ? ["stream_a"] : [], unreachable: tone === "unreachable" ? ["stream_a"] : [] },
    convertibleStreamIds: convertible ? ["stream_a"] : [],
  }
}

describe("collectComposerReferences", () => {
  it("collects shares, cross-stream quotes and in-app links, skipping same-stream quotes, private quotes and conversation links", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "sharedMessage", attrs: { messageId: "msg_1", streamId: "stream_s" } },
        { type: "quoteReply", attrs: { messageId: "msg_2", streamId: "stream_target" } },
        { type: "quoteReply", attrs: { messageId: "msg_3", streamId: "stream_q" } },
        { type: "quoteReply", attrs: { messageId: "msg_5", streamId: "stream_p", private: true } },
        {
          type: "paragraph",
          content: [
            { type: "inAppLink", attrs: { url: "x", streamId: "stream_l", messageId: null } },
            {
              type: "text",
              text: "msg",
              marks: [{ type: "link", attrs: { href: `${ORIGIN}/w/ws_1/s/stream_m?m=msg_4` } }],
            },
            {
              type: "text",
              text: "chan",
              marks: [{ type: "link", attrs: { href: `${ORIGIN}/w/ws_1/s/stream_c` } }],
            },
            {
              type: "text",
              text: "conv",
              marks: [{ type: "link", attrs: { href: `${ORIGIN}/w/ws_1/board?panel=conv:conv_1` } }],
            },
            { type: "text", text: "web", marks: [{ type: "link", attrs: { href: "https://example.org/" } }] },
          ],
        },
      ],
    }

    expect(collectComposerReferences(doc, "stream_target")).toEqual([
      { kind: "share", streamId: "stream_s", messageId: "msg_1" },
      { kind: "share", streamId: "stream_q", messageId: "msg_3" },
      { kind: "link", streamId: "stream_l", messageId: null },
      { kind: "link", streamId: "stream_m", messageId: "msg_4" },
      { kind: "link", streamId: "stream_c", messageId: null },
    ])
  })

  it("referenceStreamIds is sorted and unique", () => {
    const refs: ComposerReference[] = [
      { kind: "link", streamId: "stream_b", messageId: null },
      { kind: "share", streamId: "stream_a", messageId: "m" },
      { kind: "link", streamId: "stream_b", messageId: "m2" },
    ]
    expect(referenceStreamIds(refs)).toEqual(["stream_a", "stream_b"])
  })
})

describe("resolveSendWarning", () => {
  const refs: ComposerReference[] = [
    { kind: "share", streamId: "stream_s", messageId: "msg_1" },
    { kind: "link", streamId: "stream_l1", messageId: null },
    { kind: "link", streamId: "stream_l2", messageId: "msg_2" },
  ]

  it("returns null when nothing is exposed", () => {
    expect(resolveSendWarning(refs, exposingAudiences([audience("stream_s", 0)]))).toBeNull()
  })

  it("reveal wins over unreachable", () => {
    expect(
      resolveSendWarning(
        refs,
        exposingAudiences([audience("stream_s", 1), audience("stream_l1", 5), audience("stream_l2", 2)])
      )
    ).toEqual({
      tone: "reveal",
      lead: audience("stream_s", 1),
      exposed: { reveal: ["stream_s"], unreachable: ["stream_l1", "stream_l2"] },
      convertibleStreamIds: ["stream_s"],
    })
  })

  it("unreachable leads with the max count; only exposed message links convert", () => {
    expect(resolveSendWarning(refs, exposingAudiences([audience("stream_l1", 5), audience("stream_l2", 2)]))).toEqual({
      tone: "unreachable",
      lead: audience("stream_l1", 5),
      exposed: { reveal: [], unreachable: ["stream_l1", "stream_l2"] },
      convertibleStreamIds: ["stream_l2"],
    })
    expect(resolveSendWarning(refs, exposingAudiences([audience("stream_l1", 5)]))).toEqual({
      tone: "unreachable",
      lead: audience("stream_l1", 5),
      exposed: { reveal: [], unreachable: ["stream_l1"] },
      convertibleStreamIds: [],
    })
  })
})

describe("audienceQuestionCopy", () => {
  const unreachable = (count: number, names: string[], convertible = false) =>
    audienceQuestionCopy(warning("unreachable", count, convertible), names)
  const reveal = (count: number, names: string[]) => audienceQuestionCopy(warning("reveal", count, true), names)

  it("unreachable copy table", () => {
    expect({
      one: unreachable(1, ["Martin"], true),
      two: unreachable(2, ["Martin", "Anna"]),
      three: unreachable(3, ["Martin", "Anna", "Kim"]),
      more: unreachable(4, ["Martin", "Anna", "Kim"]),
      noNamesOne: unreachable(1, []),
      noNamesMany: unreachable(4, []),
    }).toEqual({
      one: {
        full: "Martin can't open this link",
        short: "Martin can't open it",
        alternative: { full: "Share instead", short: "Share" },
        primary: { full: "Send anyway", short: "Send" },
      },
      two: {
        full: "Martin and Anna can't open this link",
        short: "2 people can't open it",
        alternative: null,
        primary: { full: "Send anyway", short: "Send" },
      },
      three: {
        full: "Martin, Anna and Kim can't open this link",
        short: "3 people can't open it",
        alternative: null,
        primary: { full: "Send anyway", short: "Send" },
      },
      more: {
        full: "Martin, Anna +2 can't open this link",
        short: "4 people can't open it",
        alternative: null,
        primary: { full: "Send anyway", short: "Send" },
      },
      noNamesOne: {
        full: "1 person can't open this link",
        short: "1 person can't open it",
        alternative: null,
        primary: { full: "Send anyway", short: "Send" },
      },
      noNamesMany: {
        full: "4 people can't open this link",
        short: "4 people can't open it",
        alternative: null,
        primary: { full: "Send anyway", short: "Send" },
      },
    })
  })

  it("reveal copy table", () => {
    const alt = { full: "Use link", short: "Link" }
    const primary = { full: "Send", short: "Send" }
    expect({
      one: reveal(1, ["Martin"]),
      oneNoName: reveal(1, []),
      more: reveal(4, ["Martin", "Anna"]),
      noNames: reveal(4, []),
    }).toEqual({
      one: { full: "Martin will see this message", short: "Martin sees it", alternative: alt, primary },
      oneNoName: {
        full: "1 person will see this message",
        short: "1 new person sees it",
        alternative: alt,
        primary,
      },
      more: {
        full: "Martin, Anna +2 will see this message",
        short: "4 new people see it",
        alternative: alt,
        primary,
      },
      noNames: { full: "4 people will see this message", short: "4 new people see it", alternative: alt, primary },
    })
  })
})
