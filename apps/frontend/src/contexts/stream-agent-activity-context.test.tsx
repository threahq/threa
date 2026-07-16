import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { ReactNode } from "react"
import {
  StreamAgentActivityProvider,
  useAgentActivitySummary,
  usePublishAgentActivitySummary,
  type AgentActivitySummaryEntry,
} from "./stream-agent-activity-context"

const wrapper = ({ children }: { children: ReactNode }) => (
  <StreamAgentActivityProvider>{children}</StreamAgentActivityProvider>
)

const entry = (over: Partial<AgentActivitySummaryEntry> & { sessionId: string }): AgentActivitySummaryEntry => ({
  personaName: "Ariadne",
  stepCount: 0,
  ...over,
})

describe("StreamAgentActivityProvider", () => {
  it("starts empty and consumes a published summary", () => {
    const { result } = renderHook(
      () => ({ summary: useAgentActivitySummary(), publish: usePublishAgentActivitySummary() }),
      { wrapper }
    )

    expect(result.current.summary).toEqual([])

    const next = [entry({ sessionId: "s1", stepCount: 3 })]
    act(() => result.current.publish(next))

    expect(result.current.summary).toEqual(next)
  })

  it("does not re-render for an identical summary (referential stability across step-free ticks)", () => {
    const { result } = renderHook(
      () => ({ summary: useAgentActivitySummary(), publish: usePublishAgentActivitySummary() }),
      { wrapper }
    )

    act(() => result.current.publish([entry({ sessionId: "s1", stepCount: 3 })]))
    const first = result.current.summary

    // A fresh array with identical contents — must not swap the state reference.
    act(() => result.current.publish([entry({ sessionId: "s1", stepCount: 3 })]))
    expect(result.current.summary).toBe(first)

    // A real step change swaps it.
    act(() => result.current.publish([entry({ sessionId: "s1", stepCount: 4 })]))
    expect(result.current.summary).not.toBe(first)
    expect(result.current.summary[0].stepCount).toBe(4)
  })

  it("clears back to empty when the timeline publishes an empty summary", () => {
    const { result } = renderHook(
      () => ({ summary: useAgentActivitySummary(), publish: usePublishAgentActivitySummary() }),
      { wrapper }
    )

    act(() => result.current.publish([entry({ sessionId: "s1" })]))
    expect(result.current.summary).toHaveLength(1)

    act(() => result.current.publish([]))
    expect(result.current.summary).toEqual([])
  })

  it("publish is a no-op without a provider (thread-panel StreamContent)", () => {
    const { result } = renderHook(() => ({
      summary: useAgentActivitySummary(),
      publish: usePublishAgentActivitySummary(),
    }))
    expect(result.current.summary).toEqual([])
    act(() => result.current.publish([entry({ sessionId: "s1" })]))
    expect(result.current.summary).toEqual([])
  })
})
