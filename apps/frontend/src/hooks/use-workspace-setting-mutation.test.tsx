import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { WorkspaceBootstrap, WorkspaceSettings } from "@threa/types"
import { workspaceSettingsApi } from "@/api"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { useWorkspaceSettingMutation } from "./use-workspace-setting-mutation"

function seed(queryClient: QueryClient, settings: Partial<WorkspaceSettings>) {
  queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), {
    workspaceSettings: settings as WorkspaceSettings,
  } as unknown as WorkspaceBootstrap)
}

function readSettings(queryClient: QueryClient): Partial<WorkspaceSettings> {
  return (queryClient.getQueryData(workspaceKeys.bootstrap("ws_1")) as WorkspaceBootstrap).workspaceSettings
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe("useWorkspaceSettingMutation", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("writes the key optimistically", async () => {
    const queryClient = new QueryClient()
    seed(queryClient, { billingTimezone: "UTC" })
    vi.spyOn(workspaceSettingsApi, "update").mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => useWorkspaceSettingMutation("ws_1", "billingTimezone", "failed"), {
      wrapper: wrapper(queryClient),
    })
    result.current.mutate("Asia/Tokyo")

    await waitFor(() => expect(readSettings(queryClient).billingTimezone).toBe("Asia/Tokyo"))
  })

  it("rolls back only its own key when a sibling setting changed mid-flight", async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    seed(queryClient, { billingTimezone: "UTC", maxPendingFollowUps: 10 })
    // Held open so the sibling's change can land while this save is in flight.
    let fail: (e: Error) => void = () => {}
    vi.spyOn(workspaceSettingsApi, "update").mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject
      })
    )

    const { result } = renderHook(() => useWorkspaceSettingMutation("ws_1", "billingTimezone", "failed"), {
      wrapper: wrapper(queryClient),
    })
    result.current.mutate("Asia/Tokyo")
    await waitFor(() => expect(readSettings(queryClient).billingTimezone).toBe("Asia/Tokyo"))

    // A concurrent admin's edit to a different key lands while our save is in flight.
    seed(queryClient, { billingTimezone: "Asia/Tokyo", maxPendingFollowUps: 25 })
    fail(new Error("nope"))

    await waitFor(() => expect(readSettings(queryClient).billingTimezone).toBe("UTC"))
    // A whole-object restore would have dragged this back to 10.
    expect(readSettings(queryClient).maxPendingFollowUps).toBe(25)
  })

  it("takes only its own key from the response, leaving a sibling's in-flight value alone", async () => {
    const queryClient = new QueryClient()
    seed(queryClient, { billingTimezone: "UTC", maxPendingFollowUps: 10 })
    // The server's view is authoritative for committed state, but a sibling
    // mutation still in flight is not in it yet.
    vi.spyOn(workspaceSettingsApi, "update").mockResolvedValue({
      billingTimezone: "Asia/Tokyo",
      maxPendingFollowUps: 10,
    } as WorkspaceSettings)

    const { result } = renderHook(() => useWorkspaceSettingMutation("ws_1", "billingTimezone", "failed"), {
      wrapper: wrapper(queryClient),
    })
    seed(queryClient, { billingTimezone: "UTC", maxPendingFollowUps: 25 })
    result.current.mutate("Asia/Tokyo")

    await waitFor(() => expect(readSettings(queryClient).billingTimezone).toBe("Asia/Tokyo"))
    expect(readSettings(queryClient).maxPendingFollowUps).toBe(25)
  })

  it("runs the caller's onError after rolling the cache back", async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    seed(queryClient, { maxPendingFollowUps: 10 })
    vi.spyOn(workspaceSettingsApi, "update").mockRejectedValue(new Error("nope"))
    const onError = vi.fn()

    const { result } = renderHook(
      () => useWorkspaceSettingMutation("ws_1", "maxPendingFollowUps", "failed", { onError }),
      { wrapper: wrapper(queryClient) }
    )
    result.current.mutate(25)

    await waitFor(() => expect(onError).toHaveBeenCalled())
    expect(readSettings(queryClient).maxPendingFollowUps).toBe(10)
  })
})
