import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { API_VERSIONS, CURRENT_API_VERSION, type UserApiKey } from "@threahq/types"
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

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(useFormattedDateModule, "useFormattedDate").mockReturnValue({
    formatDate: (date: Date) => date.toISOString().slice(0, 10),
    formatTime: (date: Date) => date.toISOString(),
    formatRelative: (date: Date) => date.toISOString(),
    formatFull: (date: Date) => date.toISOString(),
  })
})

describe("UserApiKeysSection — API version pin", () => {
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

const OLDER_API_VERSION = API_VERSIONS[0]

describe("UserApiKeysSection — create and duplicate", () => {
  it("leaves a new key's pin to the server", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([])
    const create = vi
      .spyOn(workspacesApi, "createUserApiKey")
      .mockResolvedValue({ key: makeKey({ id: "uak_2", name: "local dev" }), value: "threa_uk_new" })
    const user = userEvent.setup()

    renderSection()

    await user.click(await screen.findByRole("button", { name: "New key" }))
    await user.type(screen.getByLabelText("Name"), "local dev")
    await user.click(screen.getByRole("checkbox", { name: /Read messages/ }))
    await user.click(screen.getByRole("button", { name: "Create key" }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]).toEqual([
      "ws_1",
      { name: "local dev", scopes: ["messages:read"], apiVersion: undefined },
    ])
  })

  it("mints a new key from an existing key's name, scopes, and pin, dropping scopes keys can no longer hold", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([
      makeKey({ scopes: ["messages:write", "streams:read", "bots:manage"], apiVersion: OLDER_API_VERSION }),
    ])
    const create = vi
      .spyOn(workspacesApi, "createUserApiKey")
      .mockResolvedValue({ key: makeKey({ id: "uak_2", name: "CI pipeline (copy)" }), value: "threa_uk_new" })
    const user = userEvent.setup()

    renderSection()

    await user.click(await screen.findByRole("button", { name: "Duplicate CI pipeline" }))

    const nameInput = screen.getByRole("textbox", {
      name: "Name",
      description: "Not copied, no longer available for keys: Manage bots",
    }) as HTMLInputElement
    expect(nameInput.value).toBe("CI pipeline (copy)")

    await user.click(screen.getByRole("button", { name: "Create key" }))

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith("ws_1", {
        name: "CI pipeline (copy)",
        scopes: ["messages:write", "streams:read"],
        apiVersion: OLDER_API_VERSION,
      })
    )
    expect(await screen.findByText("Your new API key: CI pipeline (copy)")).toBeTruthy()
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

  it("duplicating into an open form replaces the draft and focuses its name; cancel discards it", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([
      makeKey({ scopes: ["messages:write", "bots:manage"], apiVersion: OLDER_API_VERSION }),
      makeKey({ id: "uak_3", name: "Laptop", scopes: ["messages:read"] }),
    ])
    const user = userEvent.setup()

    renderSection()

    await user.click(await screen.findByRole("button", { name: "Duplicate CI pipeline" }))
    await user.click(screen.getByRole("checkbox", { name: /Read messages/ }))
    await user.click(screen.getByRole("button", { name: "Duplicate Laptop" }))

    const nameInput = screen.getByLabelText("Name") as HTMLInputElement
    expect({
      name: nameInput.value,
      focused: document.activeElement === nameInput,
      readMessages: screen.getByRole("checkbox", { name: /Read messages/ }).getAttribute("aria-checked"),
      writeMessages: screen.getByRole("checkbox", { name: /Write messages/ }).getAttribute("aria-checked"),
      droppedNote: screen.queryByText(/Not copied/),
    }).toEqual({
      name: "Laptop (copy)",
      focused: true,
      readMessages: "true",
      writeMessages: "false",
      droppedNote: null,
    })

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await user.click(screen.getByRole("button", { name: "New key" }))

    expect({
      name: (screen.getByLabelText("Name") as HTMLInputElement).value,
      readMessages: screen.getByRole("checkbox", { name: /Read messages/ }).getAttribute("aria-checked"),
    }).toEqual({ name: "", readMessages: "false" })
  })
})
