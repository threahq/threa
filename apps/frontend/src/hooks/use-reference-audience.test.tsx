import { afterEach, describe, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import { act, renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { JSONContent, ReferenceAudienceResponse } from "@threahq/types"
import * as contextsModule from "@/contexts"
import { spyOnExport } from "@/test"
import * as actorsModule from "./use-actors"
import { useReferenceAudience } from "./use-reference-audience"

const shares = (...streamIds: string[]): JSONContent => ({
  type: "doc",
  content: streamIds.map((streamId, i) => ({ type: "sharedMessage", attrs: { streamId, messageId: `msg_${i}` } })),
})

const audience = (streamId: string) => ({ streamId, count: 1, sampleUserIds: ["usr_b"] })

afterEach(() => vi.restoreAllMocks())

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
})
