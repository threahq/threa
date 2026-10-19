import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { JSONContent } from "@threahq/types"
import type { ComposerSendWarning } from "@/lib/reference-audience"
import { useSendAsk } from "./use-send-ask"

const doc = (text: string): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
})
const EMPTY: JSONContent = { type: "doc", content: [{ type: "paragraph" }] }
const DRAFT = doc("see this")

function warning(streamIds = ["stream_src"], settled = true): ComposerSendWarning {
  return {
    warning: {
      tone: "reveal",
      lead: { streamId: streamIds[0], count: 2, sampleUserIds: [] },
      streamIds,
      convertibleStreamIds: streamIds,
    },
    names: [],
    settled,
    targetKey: "stream:stream_dest",
  }
}

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

  it("abandons a waiting send when the draft changes under it", async () => {
    let settle: (value: ComposerSendWarning | null) => void = () => {}
    const awaitSendWarning = () => new Promise<ComposerSendWarning | null>((resolve) => (settle = resolve))
    const { result, rerender } = renderAsk({ sendWarning: null, content: DRAFT, awaitSendWarning })
    const send = vi.fn()

    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = result.current.submit(send)
    })
    rerender({ sendWarning: null, content: doc("something else"), awaitSendWarning })
    await act(async () => {
      settle(null)
      await pending
    })

    expect({ sent: send.mock.calls, question: result.current.question }).toEqual({ sent: [], question: null })
  })
})
