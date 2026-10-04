import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { onboardingApi } from "@/api"
import { useMeetAriadne } from "./use-meet-ariadne"

describe("useMeetAriadne", () => {
  it("should start a new request for a workspace switched to while the previous one is in flight", async () => {
    const pending = new Map<string, (value: { streamId: string }) => void>()
    const meetAriadne = vi
      .spyOn(onboardingApi, "meetAriadne")
      .mockImplementation((workspaceId) => new Promise((resolve) => pending.set(workspaceId, resolve)))
    const { result, rerender } = renderHook(({ workspaceId }) => useMeetAriadne(workspaceId), {
      initialProps: { workspaceId: "workspace_1" },
    })

    const first = result.current()
    rerender({ workspaceId: "workspace_2" })
    const second = result.current()
    pending.get("workspace_1")!({ streamId: "stream_one" })
    await first
    const repeat = result.current()
    pending.get("workspace_2")!({ streamId: "stream_two" })

    expect({
      calls: meetAriadne.mock.calls,
      first: await first,
      second: await second,
      repeatJoinsSecond: repeat === second,
    }).toEqual({
      calls: [["workspace_1"], ["workspace_2"]],
      first: "stream_one",
      second: "stream_two",
      repeatJoinsSecond: true,
    })
  })
})
