import { afterEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { toast } from "sonner"
import { preferencesApi } from "@/api"
import { PreferencesProvider, usePreferences } from "./preferences-context"

function renderPreferences() {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <PreferencesProvider workspaceId="ws_prefs">{children}</PreferencesProvider>
    </QueryClientProvider>
  )
  return renderHook(() => usePreferences(), { wrapper }).result
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("PreferencesProvider save failures", () => {
  it("reports a failed save once: a toast, unless the caller shows it in place", async () => {
    vi.spyOn(preferencesApi, "update").mockRejectedValue(new Error("offline"))
    const toastError = vi.spyOn(toast, "error").mockReturnValue("toast")
    const preferences = renderPreferences()

    await expect(preferences.current.updatePreferences({ theme: "dark" })).rejects.toThrow("offline")
    const afterReset = toastError.mock.calls.length
    await expect(preferences.current.updatePreference("theme", "dark", { errorShownInPlace: true })).rejects.toThrow(
      "offline"
    )

    expect({ afterReset, afterInPlace: toastError.mock.calls.length }).toEqual({ afterReset: 1, afterInPlace: 1 })
  })
})
