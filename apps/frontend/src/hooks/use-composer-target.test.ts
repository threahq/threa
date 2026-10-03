import { beforeEach, describe, expect, it } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { db } from "@/db"
import {
  clearComposerTarget,
  setComposerTarget,
  useComposerTarget,
  type ComposerTargetState,
} from "./use-composer-target"

const host = "stream:stream_1"

beforeEach(async () => {
  await db.composerTarget.clear()
})

describe("composer targets are per workspace", () => {
  it("should keep each workspace's target for the same host when both are set", async () => {
    await setComposerTarget("ws_a", host, "board:reply:conv_a")
    await setComposerTarget("ws_b", host, "board:reply:conv_b")

    expect(await db.composerTarget.toArray()).toEqual([
      { host, workspaceId: "ws_a", scope: "board:reply:conv_a" },
      { host, workspaceId: "ws_b", scope: "board:reply:conv_b" },
    ])
  })

  it("should leave the other workspace's target in place when one is cleared", async () => {
    await setComposerTarget("ws_a", host, "board:reply:conv_a")
    await setComposerTarget("ws_b", host, "board:reply:conv_b")

    await clearComposerTarget("ws_a", host)

    expect(await db.composerTarget.toArray()).toEqual([{ host, workspaceId: "ws_b", scope: "board:reply:conv_b" }])
  })

  it("should resolve each workspace's own target for the same host", async () => {
    await setComposerTarget("ws_a", host, "board:reply:conv_a")
    await setComposerTarget("ws_b", host, "board:reply:conv_b")

    const { result: inA } = renderHook(() => useComposerTarget("ws_a", host))
    const { result: inB } = renderHook(() => useComposerTarget("ws_b", host))

    await waitFor(() => expect(inA.current).toEqual({ scope: "board:reply:conv_a", isResolved: true }))
    await waitFor(() => expect(inB.current).toEqual({ scope: "board:reply:conv_b", isResolved: true }))
  })

  it("should be unresolved in the first render after a workspace switch and then settle on the new workspace's target", async () => {
    await setComposerTarget("ws_a", host, "board:reply:conv_a")
    await setComposerTarget("ws_b", host, "board:reply:conv_b")
    const seen: Array<{ workspaceId: string; state: ComposerTargetState }> = []

    const { result, rerender } = renderHook(
      ({ workspaceId }: { workspaceId: string }) => {
        const state = useComposerTarget(workspaceId, host)
        seen.push({ workspaceId, state })
        return state
      },
      { initialProps: { workspaceId: "ws_a" } }
    )
    await waitFor(() => expect(result.current).toEqual({ scope: "board:reply:conv_a", isResolved: true }))
    seen.length = 0

    rerender({ workspaceId: "ws_b" })
    await waitFor(() => expect(result.current).toEqual({ scope: "board:reply:conv_b", isResolved: true }))

    expect({
      first: seen[0],
      leakedFromA: seen.filter((render) => render.state.scope === "board:reply:conv_a"),
    }).toEqual({
      first: { workspaceId: "ws_b", state: { scope: null, isResolved: false } },
      leakedFromA: [],
    })
  })
})
