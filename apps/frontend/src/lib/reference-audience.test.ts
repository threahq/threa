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

const ORIGIN = "https://app.example.test"

function audience(streamId: string, count: number): ReferenceAudience {
  return { streamId, count, sampleUserIds: [] }
}

function warning(overrides: Partial<SendWarning> & { count: number }): SendWarning {
  const { count, ...rest } = overrides
  return {
    tone: "unreachable",
    lead: audience("stream_a", count),
    exposedShareStreamIds: [],
    exposedLinkStreamIds: ["stream_a"],
    canShareInstead: false,
    ...rest,
  }
}

describe("collectComposerReferences", () => {
  it("collects shares, cross-stream quotes and in-app links, skipping same-stream quotes and conversation links", () => {
    const doc: JSONContent = {
      type: "doc",
      content: [
        { type: "sharedMessage", attrs: { messageId: "msg_1", streamId: "stream_s" } },
        { type: "quoteReply", attrs: { messageId: "msg_2", streamId: "stream_target" } },
        { type: "quoteReply", attrs: { messageId: "msg_3", streamId: "stream_q" } },
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

    expect(collectComposerReferences(doc, "stream_target", ORIGIN)).toEqual([
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
      exposedShareStreamIds: ["stream_s"],
      exposedLinkStreamIds: ["stream_l1", "stream_l2"],
      canShareInstead: true,
    })
  })

  it("unreachable leads with the max count; canShareInstead needs an exposed message link", () => {
    expect(resolveSendWarning(refs, exposingAudiences([audience("stream_l1", 5), audience("stream_l2", 2)]))).toEqual({
      tone: "unreachable",
      lead: audience("stream_l1", 5),
      exposedShareStreamIds: [],
      exposedLinkStreamIds: ["stream_l1", "stream_l2"],
      canShareInstead: true,
    })
    expect(resolveSendWarning(refs, exposingAudiences([audience("stream_l1", 5)]))).toEqual({
      tone: "unreachable",
      lead: audience("stream_l1", 5),
      exposedShareStreamIds: [],
      exposedLinkStreamIds: ["stream_l1"],
      canShareInstead: false,
    })
  })
})

describe("audienceQuestionCopy", () => {
  const unreachable = (count: number, names: string[], canShareInstead = false) =>
    audienceQuestionCopy(warning({ count, canShareInstead }), names)
  const reveal = (count: number, names: string[]) => audienceQuestionCopy(warning({ count, tone: "reveal" }), names)

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
        desktop: "Martin can't open this link",
        mobile: "Martin can't open it",
        alternative: { desktop: "Share instead", mobile: "Share" },
        primary: "Send anyway",
      },
      two: {
        desktop: "Martin and Anna can't open this link",
        mobile: "2 people can't open it",
        alternative: null,
        primary: "Send anyway",
      },
      three: {
        desktop: "Martin, Anna and Kim can't open this link",
        mobile: "3 people can't open it",
        alternative: null,
        primary: "Send anyway",
      },
      more: {
        desktop: "Martin, Anna +2 can't open this link",
        mobile: "4 people can't open it",
        alternative: null,
        primary: "Send anyway",
      },
      noNamesOne: {
        desktop: "1 person can't open this link",
        mobile: "1 person can't open it",
        alternative: null,
        primary: "Send anyway",
      },
      noNamesMany: {
        desktop: "4 people can't open this link",
        mobile: "4 people can't open it",
        alternative: null,
        primary: "Send anyway",
      },
    })
  })

  it("reveal copy table", () => {
    const alt = { desktop: "Use link", mobile: "Link" }
    const primary = "Send"
    expect({
      one: reveal(1, ["Martin"]),
      oneNoName: reveal(1, []),
      more: reveal(4, ["Martin", "Anna"]),
      noNames: reveal(4, []),
    }).toEqual({
      one: { desktop: "Martin will see this message", mobile: "Martin sees it", alternative: alt, primary },
      oneNoName: {
        desktop: "1 person will see this message",
        mobile: "1 new person sees it",
        alternative: alt,
        primary,
      },
      more: {
        desktop: "Martin, Anna +2 will see this message",
        mobile: "4 new people see it",
        alternative: alt,
        primary,
      },
      noNames: { desktop: "4 people will see this message", mobile: "4 new people see it", alternative: alt, primary },
    })
  })
})
