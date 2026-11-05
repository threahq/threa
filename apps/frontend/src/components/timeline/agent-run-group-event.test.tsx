import { spyOnExport } from "@/test/spy"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, renderHook, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import type { StreamEvent } from "@threahq/types"
import * as contextsModule from "@/contexts"
import * as relativeTimeModule from "@/components/relative-time"
import { __resetCollapseCacheForTests } from "@/lib/markdown/collapse-cache"
import { useLastSeenEvent } from "@/hooks/use-last-seen-event"
import {
  TimelineItemContent,
  groupTimelineItems,
  mergeAgentRunGroups,
  type TimelineItem,
  type TimelineItemRenderContext,
} from "./event-list"
import { AgentRunGroupEvent } from "./agent-run-group-event"

type RunGroup = Extract<TimelineItem, { type: "agent_run_group" }>

interface RunSpec {
  id: string
  persona?: string
  outcome?: "completed" | "failed"
}

function event(id: string, sequence: number, eventType: StreamEvent["eventType"], payload: unknown): StreamEvent {
  return {
    id,
    streamId: "stream_1",
    sequence: String(sequence),
    eventType,
    payload,
    actorId: "persona_1",
    actorType: "persona",
    createdAt: "2026-02-19T18:00:00.000Z",
  }
}

function runEvents({ id, persona = "Ariadne", outcome = "completed" }: RunSpec, index: number): StreamEvent[] {
  const base = index * 2 + 1
  const started = event(`${id}_started`, base, "agent_session:started", {
    sessionId: id,
    personaId: `persona_${persona}`,
    personaName: persona,
    triggerMessageId: null,
    startedAt: "2026-02-19T18:00:00.000Z",
  })
  const ended =
    outcome === "completed"
      ? event(`${id}_ended`, base + 1, "agent_session:completed", {
          sessionId: id,
          stepCount: 2,
          messageCount: 1,
          duration: 5000,
          completedAt: "2026-02-19T18:00:05.000Z",
        })
      : event(`${id}_ended`, base + 1, "agent_session:failed", {
          sessionId: id,
          stepCount: 3,
          error: "boom",
          traceId: id,
          failedAt: "2026-02-19T18:01:05.000Z",
        })
  return [started, ended]
}

function buildGroup(specs: RunSpec[], frontierSequence?: bigint | null): RunGroup {
  const items = mergeAgentRunGroups(groupTimelineItems(specs.flatMap(runEvents), "member_1"), { frontierSequence })
  expect(items).toHaveLength(1)
  return items[0] as RunGroup
}

function renderGroup(group: RunGroup) {
  return render(
    <MemoryRouter>
      <AgentRunGroupEvent sessions={group.sessions} unreadCount={group.unreadCount} />
    </MemoryRouter>
  )
}

const THREE_DONE: RunSpec[] = [{ id: "s1" }, { id: "s2" }, { id: "s3" }]

beforeEach(() => {
  vi.restoreAllMocks()
  __resetCollapseCacheForTests()
  vi.spyOn(contextsModule, "useTrace").mockReturnValue({
    getTraceUrl: (sessionId: string) => `/trace/${sessionId}`,
  } as ReturnType<typeof contextsModule.useTrace>)
  spyOnExport(relativeTimeModule, "RelativeTime").mockReturnValue((() => (
    <span>just now</span>
  )) as unknown as typeof relativeTimeModule.RelativeTime)
})

describe("AgentRunGroupEvent", () => {
  it("collapses three completed sessions into one summed header with no rows", () => {
    renderGroup(buildGroup(THREE_DONE))

    const header = screen.getByRole("button", { expanded: false })
    expect({
      title: within(header).queryByText("3 sessions complete") !== null,
      subtitle: within(header).queryByText("6 steps • 15.0s • 3 messages sent") !== null,
      links: screen.queryAllByRole("link").length,
    }).toEqual({ title: true, subtitle: true, links: 0 })
  })

  it("titles a group with a failure and lists one trace link per session when expanded", () => {
    renderGroup(buildGroup([{ id: "s1" }, { id: "s2", outcome: "failed" }, { id: "s3" }]))

    expect(within(screen.getByRole("button")).queryByText("3 sessions · 1 failed")).not.toBeNull()
    fireEvent.click(screen.getByRole("button"))

    const links = screen.getAllByRole("link")
    expect({
      hrefs: links.map((l) => l.getAttribute("href")),
      failedLine: within(links[1]).queryByText("3 steps • 1m 5s • Error during execution") !== null,
    }).toEqual({ hrefs: ["/trace/s1", "/trace/s2", "/trace/s3"], failedLine: true })
  })

  it("leaves persona names off when every session ran as the same agent", () => {
    renderGroup(buildGroup(THREE_DONE))
    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByText("Ariadne")).toBeNull()
  })

  it("names each session's agent when the group mixes agents", () => {
    renderGroup(buildGroup([{ id: "s1" }, { id: "s2", persona: "Hermes" }]))
    fireEvent.click(screen.getByRole("button"))
    const names = screen.getAllByRole("link").map((l) => within(l).queryByText(/Ariadne|Hermes/)?.textContent)
    expect(names).toEqual(["Ariadne", "Hermes"])
  })

  it("stays expanded across a remount", () => {
    const group = buildGroup(THREE_DONE)
    const first = renderGroup(group)
    fireEvent.click(screen.getByRole("button"))
    first.unmount()

    renderGroup(group)
    expect(screen.getAllByRole("link")).toHaveLength(3)
  })

  it("shows the unread count as a pill", () => {
    renderGroup(buildGroup(THREE_DONE, 2n))
    expect(screen.getByText("2 new")).toBeTruthy()
  })

  it("keeps the viewer's choice when an earlier run joins at the head", () => {
    const tail = buildGroup([{ id: "s2" }, { id: "s3" }])
    const first = renderGroup(tail)
    fireEvent.click(screen.getByRole("button"))
    first.unmount()

    const grown = renderGroup(buildGroup([{ id: "s1" }, { id: "s2" }, { id: "s3" }]))
    expect(screen.getAllByRole("link")).toHaveLength(3)
    fireEvent.click(screen.getByRole("button"))
    grown.unmount()

    renderGroup(tail)
    expect(screen.queryAllByRole("link")).toHaveLength(0)
  })

  it("lets the read scan reach the group's last run", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0)
      return 0
    })
    const events = THREE_DONE.flatMap(runEvents)
    const group = buildGroup(THREE_DONE)
    const ctx = { workspaceId: "ws_1", streamId: "stream_1", hideSessionCards: false } as TimelineItemRenderContext
    const { container } = render(
      <MemoryRouter>
        <TimelineItemContent item={group} ctx={ctx} deferSecondaryHydration={false} />
      </MemoryRouter>
    )
    container.getBoundingClientRect = () => ({ top: 0, bottom: 500 }) as DOMRect
    for (const row of container.querySelectorAll<HTMLElement>("[data-event-id]")) {
      row.getBoundingClientRect = () => ({ top: 10, bottom: 70 }) as DOMRect
    }

    const { result } = renderHook(() =>
      useLastSeenEvent({
        scrollContainerRef: { current: container },
        events,
        streamId: "stream_1",
        lastReadEventId: null,
        lastReadSequence: null,
        enabled: true,
      })
    )
    expect(result.current.lastSeenEventId).toBe("s3_started")
  })
})
