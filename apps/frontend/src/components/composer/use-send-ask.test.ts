import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { JSONContent } from "@threahq/types"
import type { ComposerSendWarning, SendWarning } from "@/lib/reference-audience"
import { useSendAsk } from "./use-send-ask"

const doc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})
const EMPTY: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
const DRAFT = doc("see this")

function warning(streamIds = ["stream_src"], settled = true): ComposerSendWarning {
  return exposing({ reveal: streamIds }, streamIds, settled)
}

function exposing(
  exposed: Partial<SendWarning["exposed"]>,
  convertibleStreamIds: string[],
  settled = true
): ComposerSendWarning {
  const full = { reveal: exposed.reveal ?? [], unreachable: exposed.unreachable ?? [] }
  const tone = full.reveal.length > 0 ? "reveal" : "unreachable"
  return {
    warning: {
      tone,
      lead: { streamId: full[tone][0], count: 2, sampleUserIds: [] },
      exposed: full,
      convertibleStreamIds,
    },
    names: [],
    settled,
    targetKey: "stream:stream_dest",
  }
}

/** The same draft after a node view stamped a resolved label in. */
const stamped = (content: JSONContent): JSONContent => ({
  ...content,
  content: [
    ...(content.content ?? []),
    { type: "sharedMessage", attrs: { streamId: "stream_src", messageId: "msg_1", authorName: "Ada" } },
  ],
})
const unstamped = (content: JSONContent): JSONContent => ({
  ...content,
  content: [
    ...(content.content ?? []),
    { type: "sharedMessage", attrs: { streamId: "stream_src", messageId: "msg_1", authorName: "" } },
  ],
})

type Props = Parameters<typeof useSendAsk>[0]

function renderAsk(initial: Props) {
  return renderHook((props: Props) => useSendAsk(props), { initialProps: initial })
}

async function submit(result: { current: ReturnType<typeof useSendAsk> }) {
  const send = vi.fn()
  await act(() => result.current.submit(send))
  return send
}

describe("useSendAsk", () => {
  it("asks first, then tells the server the reveal was seen only for a settled answer", async () => {
    const settled = renderAsk({ sendWarning: warning(), content: DRAFT })
    const firstSend = await submit(settled.result)
    const asked = settled.result.current.question?.tone
    const confirmedSend = await submit(settled.result)

    const unsettled = renderAsk({ sendWarning: warning(["stream_src"], false), content: DRAFT })
    await submit(unsettled.result)
    const unsettledSend = await submit(unsettled.result)

    expect({
      firstSend: firstSend.mock.calls,
      asked,
      confirmedSend: confirmedSend.mock.calls,
      unsettledSend: unsettledSend.mock.calls,
    }).toEqual({
      firstSend: [],
      asked: "reveal",
      confirmedSend: [[{ confirmedPrivacyWarning: true }]],
      unsettledSend: [[undefined]],
    })
  })

  it("asks again about the same source once the draft has emptied", async () => {
    const { result, rerender } = renderAsk({ sendWarning: warning(), content: DRAFT })
    await submit(result)
    await submit(result)

    const next = doc("see this again")
    rerender({ sendWarning: warning(), content: next })
    const whileConsented = await submit(result)

    rerender({ sendWarning: null, content: EMPTY })
    rerender({ sendWarning: warning(), content: next })
    const afterEmpty = await submit(result)

    expect({ whileConsented: whileConsented.mock.calls, afterEmpty: afterEmpty.mock.calls }).toEqual({
      whileConsented: [[{ confirmedPrivacyWarning: true }]],
      afterEmpty: [],
    })
  })

  it("drops the open question when the warning it asked about changes", async () => {
    const { result, rerender } = renderAsk({ sendWarning: warning(), content: DRAFT })
    await submit(result)
    const before = result.current.question !== null

    rerender({ sendWarning: warning(["stream_src", "stream_other"]), content: DRAFT })

    expect({ before, after: result.current.question }).toEqual({ before: true, after: null })
  })

  it("waits for an unsettled answer before deciding, and sends when none arrives", async () => {
    const awaitSendWarning = async () => warning()
    const asks = renderAsk({ sendWarning: null, content: DRAFT, awaitSendWarning })
    const askedSend = await submit(asks.result)
    // The awaited answer lands in the shared query cache, so the next render carries it.
    asks.rerender({ sendWarning: warning(), content: DRAFT, awaitSendWarning: null })

    const timesOut = renderAsk({ sendWarning: null, content: DRAFT, awaitSendWarning: async () => null })
    const timedOutSend = await submit(timesOut.result)

    expect({
      askedSend: askedSend.mock.calls,
      asked: asks.result.current.question?.tone,
      timedOutSend: timedOutSend.mock.calls,
    }).toEqual({ askedSend: [], asked: "reveal", timedOutSend: [[undefined]] })
  })

  it("drops a waiting send once the author keeps typing, leaving the draft for the next Send", async () => {
    let settle: (value: ComposerSendWarning | null) => void = () => {}
    const awaitSendWarning = () => new Promise<ComposerSendWarning | null>((resolve) => (settle = resolve))
    const { result, rerender } = renderAsk({ sendWarning: null, content: DRAFT, awaitSendWarning })
    const send = vi.fn()

    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = result.current.submit(send)
    })
    rerender({ sendWarning: warning(), content: doc("something else"), awaitSendWarning })
    await act(async () => {
      settle(warning())
      await pending
    })

    expect({ sent: send.mock.calls, asked: result.current.question }).toEqual({ sent: [], asked: null })
  })

  it("still asks or sends when a display stamp lands while the answer is awaited", async () => {
    async function pressSendThenStamp(answer: ComposerSendWarning | null) {
      let settle: (value: ComposerSendWarning | null) => void = () => {}
      const awaitSendWarning = () => new Promise<ComposerSendWarning | null>((resolve) => (settle = resolve))
      const view = renderAsk({ sendWarning: null, content: unstamped(DRAFT), awaitSendWarning })
      const send = vi.fn()
      let pending: Promise<void> = Promise.resolve()
      act(() => {
        pending = view.result.current.submit(send)
      })
      view.rerender({ sendWarning: answer, content: stamped(DRAFT), awaitSendWarning })
      await act(async () => {
        settle(answer)
        await pending
      })
      return { sent: send.mock.calls, asked: view.result.current.question?.tone }
    }

    expect({ asks: await pressSendThenStamp(warning()), sends: await pressSendThenStamp(null) }).toEqual({
      asks: { sent: [], asked: "reveal" },
      sends: { sent: [[undefined]], asked: undefined },
    })
  })

  it("keeps an open question when only a display stamp lands", async () => {
    const { result, rerender } = renderAsk({ sendWarning: warning(), content: unstamped(DRAFT) })
    await submit(result)

    rerender({ sendWarning: warning(), content: stamped(DRAFT) })

    expect(result.current.question?.tone).toBe("reveal")
  })

  describe("consent per tone", () => {
    const LINK_A_STREAM_B = exposing({ unreachable: ["stream_a", "stream_b"] }, ["stream_a"])

    it("Share instead consents to revealing the converted source only, never another linked one", async () => {
      const { result, rerender } = renderAsk({ sendWarning: LINK_A_STREAM_B, content: DRAFT })
      await submit(result)
      act(() => result.current.recordAlternative())

      rerender({
        sendWarning: exposing({ reveal: ["stream_a"], unreachable: ["stream_b"] }, ["stream_a"]),
        content: DRAFT,
      })
      const convertedSend = await submit(result)

      rerender({
        sendWarning: exposing({ reveal: ["stream_a", "stream_b"], unreachable: ["stream_b"] }, [
          "stream_a",
          "stream_b",
        ]),
        content: DRAFT,
      })
      const sharedBSend = await submit(result)

      expect({
        convertedSend: convertedSend.mock.calls,
        sharedBSend: sharedBSend.mock.calls,
        asked: result.current.question?.tone,
      }).toEqual({ convertedSend: [[{ confirmedPrivacyWarning: true }]], sharedBSend: [], asked: "reveal" })
    })

    it("Send anyway on a link never answers a later share from the same source", async () => {
      const { result, rerender } = renderAsk({ sendWarning: LINK_A_STREAM_B, content: DRAFT })
      await submit(result)
      const sentAnyway = await submit(result)

      rerender({
        sendWarning: exposing({ reveal: ["stream_b"], unreachable: ["stream_a", "stream_b"] }, ["stream_b"]),
        content: DRAFT,
      })
      const sharedBSend = await submit(result)

      expect({
        sentAnyway: sentAnyway.mock.calls,
        sharedBSend: sharedBSend.mock.calls,
        asked: result.current.question?.tone,
      }).toEqual({
        sentAnyway: [[undefined]],
        sharedBSend: [],
        asked: "reveal",
      })
    })

    it("Use link answers only for the links it made, not another link the question never named", async () => {
      const { result, rerender } = renderAsk({
        sendWarning: exposing({ reveal: ["stream_a"], unreachable: ["stream_b"] }, ["stream_a"]),
        content: DRAFT,
      })
      await submit(result)
      act(() => result.current.recordAlternative())

      rerender({ sendWarning: exposing({ unreachable: ["stream_a", "stream_b"] }, ["stream_a"]), content: DRAFT })
      const linkSend = await submit(result)

      expect({ linkSend: linkSend.mock.calls, asked: result.current.question?.tone }).toEqual({
        linkSend: [],
        asked: "unreachable",
      })
    })

    it("Use link declines the reveal: the link sends, a re-added share asks again", async () => {
      const { result, rerender } = renderAsk({ sendWarning: warning(["stream_a"]), content: DRAFT })
      await submit(result)
      act(() => result.current.recordAlternative())

      rerender({ sendWarning: exposing({ unreachable: ["stream_a"] }, ["stream_a"]), content: DRAFT })
      const linkSend = await submit(result)

      rerender({
        sendWarning: exposing({ reveal: ["stream_a"], unreachable: ["stream_a"] }, ["stream_a"]),
        content: DRAFT,
      })
      const reshareSend = await submit(result)

      expect({
        linkSend: linkSend.mock.calls,
        reshareSend: reshareSend.mock.calls,
        asked: result.current.question?.tone,
      }).toEqual({
        linkSend: [[undefined]],
        reshareSend: [],
        asked: "reveal",
      })
    })
  })
})
