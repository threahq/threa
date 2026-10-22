import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { CURRENT_API_VERSION, type UserApiKey } from "@threahq/types"
import { workspacesApi } from "@/api/workspaces"
import * as useFormattedDateModule from "@/hooks/use-formatted-date"
import { TooltipProvider } from "@/components/ui/tooltip"
import { UserApiKeysSection } from "./user-api-keys-section"

function makeKey(overrides: Partial<UserApiKey> = {}): UserApiKey {
  return {
    id: "uak_1",
    name: "CI pipeline",
    keyPrefix: "abcd",
    scopes: ["messages:write"],
    apiVersion: null,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  }
}

function renderSection(queryClient = new QueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <UserApiKeysSection workspaceId="ws_1" />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe("UserApiKeysSection — API version pin", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(useFormattedDateModule, "useFormattedDate").mockReturnValue({
      formatDate: (date: Date) => date.toISOString().slice(0, 10),
      formatTime: (date: Date) => date.toISOString(),
      formatRelative: (date: Date) => date.toISOString(),
      formatFull: (date: Date) => date.toISOString(),
    })
  })

  it("shows the tracked-latest state for an unpinned key and pins it to a dated version", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([makeKey({ apiVersion: null })])
    const update = vi
      .spyOn(workspacesApi, "updateUserApiKeyVersion")
      .mockResolvedValue(makeKey({ apiVersion: CURRENT_API_VERSION }))
    const user = userEvent.setup()

    renderSection()

    const trigger = await screen.findByRole("button", {
      name: new RegExp(`API version:.*Latest \\(${CURRENT_API_VERSION}\\)`),
    })
    await user.click(trigger)

    await user.click(await screen.findByRole("menuitemradio", { name: CURRENT_API_VERSION }))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "uak_1", CURRENT_API_VERSION))
  })

  it("shows the pinned date for a pinned key and detaches it back to latest", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([makeKey({ apiVersion: CURRENT_API_VERSION })])
    const update = vi.spyOn(workspacesApi, "updateUserApiKeyVersion").mockResolvedValue(makeKey({ apiVersion: null }))
    const user = userEvent.setup()

    renderSection()

    const trigger = await screen.findByRole("button", {
      name: (name) => name.includes("API version") && name.includes(CURRENT_API_VERSION) && !name.includes("Latest"),
    })
    await user.click(trigger)

    await user.click(await screen.findByRole("menuitemradio", { name: /Always latest/ }))

    await waitFor(() => expect(update).toHaveBeenCalledWith("ws_1", "uak_1", null))
  })
})

describe("UserApiKeysSection — duplicate", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(useFormattedDateModule, "useFormattedDate").mockReturnValue({
      formatDate: (date: Date) => date.toISOString().slice(0, 10),
      formatTime: (date: Date) => date.toISOString(),
      formatRelative: (date: Date) => date.toISOString(),
      formatFull: (date: Date) => date.toISOString(),
    })
  })

  it("mints a new key from an existing key's name, scopes, and pin, dropping scopes keys can no longer hold", async () => {
    const olderVersion = "2026-10-01"
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([
      makeKey({ scopes: ["messages:write", "streams:read", "bots:manage"], apiVersion: olderVersion }),
    ])
    const create = vi
      .spyOn(workspacesApi, "createUserApiKey")
      .mockResolvedValue({ key: makeKey({ id: "uak_2" }), value: "threa_uk_new" })
    const user = userEvent.setup()

    renderSection()

    await user.click(await screen.findByRole("button", { name: "Duplicate CI pipeline" }))

    expect({
      name: (screen.getByLabelText("Name") as HTMLInputElement).value,
      dropped: screen.getByText(/Not copied, no longer available for keys/).textContent,
    }).toEqual({
      name: "CI pipeline (copy)",
      dropped: "Not copied, no longer available for keys: Manage bots",
    })

    await user.click(screen.getByRole("button", { name: "Create key" }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith("ws_1", {
        name: "CI pipeline (copy)",
        scopes: ["messages:write", "streams:read"],
        apiVersion: olderVersion,
      })
    )
    expect(await screen.findByText("threa_uk_new")).toBeTruthy()
  })

  it("keeps an unpinned source key unpinned", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([makeKey({ apiVersion: null })])
    const create = vi
      .spyOn(workspacesApi, "createUserApiKey")
      .mockResolvedValue({ key: makeKey({ id: "uak_2" }), value: "threa_uk_new" })
    const user = userEvent.setup()

    renderSection()

    await user.click(await screen.findByRole("button", { name: "Duplicate CI pipeline" }))
    await user.click(screen.getByRole("button", { name: "Create key" }))

    await waitFor(() => expect(create).toHaveBeenCalledWith("ws_1", expect.objectContaining({ apiVersion: null })))
  })
})
