import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { JSONContent, ReferenceAudienceResponse } from "@threahq/types"
import * as contextsModule from "@/contexts"
import { spyOnExport } from "@/test"
import * as actorsModule from "./use-actors"
import { referenceAudienceTargetFor, useReferenceAudience } from "./use-reference-audience"

const shares = (...streamIds: string[]): JSONContent => ({
  type: "doc",
  content: streamIds.map((streamId, i) => ({ type: "sharedMessage", attrs: { streamId, messageId: `msg_${i}` } })),
})

const audience = (streamId: string) => ({ streamId, count: 1, sampleUserIds: ["usr_b"] })

afterEach(() => vi.restoreAllMocks())

function renderAudience(
  referenceAudience: () => Promise<ReferenceAudienceResponse>,
  content = shares("stream_a"),
  previousContent?: JSONContent
) {
  spyOnExport(contextsModule, "useMessageService").mockReturnValue((() => ({ referenceAudience })) as never)
  spyOnExport(actorsModule, "useActors").mockReturnValue((() => ({ getUser: () => ({ name: "Bea" }) })) as never)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(
    () => useReferenceAudience({ workspaceId: "ws_1", target: { streamId: "stream_dest" }, content, previousContent }),
    { wrapper }
  )
}

describe("referenceAudienceTargetFor", () => {
  it("asks about a DM draft's peer, a known plaintext stream, and nothing else", () => {
    expect({
      dmDraft: referenceAudienceTargetFor("draft_dm_usr_b", undefined),
      scratchpadDraft: referenceAudienceTargetFor("draft_abc", { e2eEnabled: false }),
      unresolved: referenceAudienceTargetFor("stream_dest", undefined),
      e2e: referenceAudienceTargetFor("stream_dest", { e2eEnabled: true }),
      plaintext: referenceAudienceTargetFor("stream_dest", { e2eEnabled: false }),
    }).toEqual({
      dmDraft: { dmUserId: "usr_b" },
      scratchpadDraft: null,
      unresolved: null,
      e2e: null,
      plaintext: { streamId: "stream_dest" },
    })
  })
})

describe("useReferenceAudience", () => {
  it("claims a settled answer only once the server has answered for every ref in the draft", async () => {
    const answers: ((response: ReferenceAudienceResponse) => void)[] = []
    spyOnExport(contextsModule, "useMessageService").mockReturnValue((() => ({
      referenceAudience: () => new Promise<ReferenceAudienceResponse>((resolve) => answers.push(resolve)),
    })) as never)
    spyOnExport(actorsModule, "useActors").mockReturnValue((() => ({ getUser: () => ({ name: "Bea" }) })) as never)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )

    const { result, rerender } = renderHook(
      ({ content }) => useReferenceAudience({ workspaceId: "ws_1", target: { streamId: "stream_dest" }, content }),
      { wrapper, initialProps: { content: shares("stream_a") } }
    )
    await waitFor(() => expect(answers).toHaveLength(1))
    act(() => answers[0]({ audiences: [audience("stream_a")] }))
    await waitFor(() => expect(result.current.sendWarning?.settled).toBe(true))

    rerender({ content: shares("stream_a", "stream_b") })
    await waitFor(() => expect(answers).toHaveLength(2))
    const whilePending = {
      tone: result.current.sendWarning?.warning.tone,
      settled: result.current.sendWarning?.settled,
    }

    act(() => answers[1]({ audiences: [audience("stream_a"), audience("stream_b")] }))
    await waitFor(() => expect(result.current.sendWarning?.settled).toBe(true))
    expect({ whilePending, names: result.current.sendWarning?.names }).toEqual({
      whilePending: { tone: "reveal", settled: false },
      names: ["Bea"],
    })
  })

  it("lets a send wait for the in-flight answer and hands back the settled warning", async () => {
    let answer: (response: ReferenceAudienceResponse) => void = () => {}
    const referenceAudience = vi.fn(() => new Promise<ReferenceAudienceResponse>((resolve) => (answer = resolve)))
    const { result } = renderAudience(referenceAudience)
    await waitFor(() => expect(referenceAudience).toHaveBeenCalled())

    const awaited = result.current.awaitSendWarning!()
    answer({ audiences: [audience("stream_a")] })
    const warning = await awaited

    await waitFor(() => expect(result.current.awaitSendWarning).toBeNull())
    expect({
      tone: warning?.warning.tone,
      settled: warning?.settled,
      lookups: referenceAudience.mock.calls.length,
    }).toEqual({ tone: "reveal", settled: true, lookups: 1 })
  })

  it("gives up waiting with no warning when the lookup fails", async () => {
    let fail: (error: Error) => void = () => {}
    const { result } = renderAudience(() => new Promise<ReferenceAudienceResponse>((_, reject) => (fail = reject)))
    await waitFor(() => expect(result.current.awaitSendWarning).not.toBeNull())

    const awaited = result.current.awaitSendWarning!()
    fail(new Error("offline"))
    expect(await awaited).toBeNull()
  })

  it("gives up waiting with no warning when the lookup outlasts the wait", async () => {
    const { result } = renderAudience(() => new Promise<ReferenceAudienceResponse>(() => {}))
    await waitFor(() => expect(result.current.awaitSendWarning).not.toBeNull())

    expect(await result.current.awaitSendWarning!()).toBeNull()
  })

  it("tints every ref in an edit but asks only about the ones the edit adds", async () => {
    const added = renderAudience(
      async () => ({ audiences: [audience("stream_a"), audience("stream_b")] }),
      shares("stream_a", "stream_b"),
      shares("stream_a")
    )
    await waitFor(() => expect(added.result.current.sendWarning?.settled).toBe(true))
    const kept = renderAudience(
      async () => ({ audiences: [audience("stream_a")] }),
      shares("stream_a"),
      shares("stream_a")
    )
    await waitFor(() => expect(kept.result.current.audienceByStreamId.size).toBe(1))

    expect({
      addedTinted: [...added.result.current.audienceByStreamId.keys()],
      addedAsks: added.result.current.sendWarning?.warning.exposed.reveal,
      keptAsks: kept.result.current.sendWarning,
    }).toEqual({ addedTinted: ["stream_a", "stream_b"], addedAsks: ["stream_b"], keptAsks: null })
  })
})
