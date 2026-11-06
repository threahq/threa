import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { API_VERSIONS, CURRENT_API_VERSION, type UserApiKey } from "@threahq/types"
import { workspacesApi } from "@/api/workspaces"
import * as useFormattedDateModule from "@/hooks/use-formatted-date"
import { TooltipProvider } from "@/components/ui/tooltip"
import { UserApiKeysSection } from "./user-api-keys-section"

const OLDER_API_VERSION = API_VERSIONS[0]

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

/** The None / Read / Write choice of one permission area in the open key dialog. */
function levelRadio(area: string, level: "None" | "Read" | "Write") {
  return within(screen.getByRole("radiogroup", { name: area })).getByRole("radio", { name: level }) as HTMLButtonElement
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

// The create dialog is modal, so the list's version triggers are hidden from the accessibility tree.
const formVersionTrigger = () => screen.getByRole("button", { name: /API version/ }) as HTMLButtonElement

async function duplicate(user: ReturnType<typeof userEvent.setup>, keyName: string) {
  await user.click(await screen.findByRole("button", { name: `Actions for ${keyName}` }))
  await user.click(await screen.findByRole("menuitem", { name: "Duplicate" }))
}

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
    await user.click(levelRadio("Messages", "Read"))
    await user.click(screen.getByRole("button", { name: "Create key" }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]).toEqual([
      "ws_1",
      { name: "local dev", scopes: ["messages:read"], apiVersion: undefined },
    ])
  })

  it("builds a key's permissions from a preset, a group level, and one expanded permission", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([])
    const create = vi
      .spyOn(workspacesApi, "createUserApiKey")
      .mockResolvedValue({ key: makeKey({ id: "uak_2", name: "bot" }), value: "threa_uk_new" })
    const user = userEvent.setup()

    renderSection()

    await user.click(await screen.findByRole("button", { name: "New key" }))
    await user.type(screen.getByLabelText("Name"), "bot")
    await user.click(screen.getByRole("radio", { name: "Connected bot" }))
    await user.click(
      within(screen.getByRole("radiogroup", { name: "All Workspace" })).getByRole("radio", { name: "Read" })
    )
    await user.click(screen.getByRole("button", { name: "Streams" }))
    await user.click(screen.getByRole("checkbox", { name: /Write streams/ }))

    expect({
      preset: screen.getByRole("radio", { name: "Connected bot" }).getAttribute("aria-checked"),
      streams: levelRadio("Streams", "Write").getAttribute("aria-checked"),
      labels: levelRadio("Labels", "Read").getAttribute("aria-checked"),
    }).toEqual({ preset: "false", streams: "true", labels: "true" })

    await user.click(screen.getByRole("button", { name: "Create key" }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect([...create.mock.calls[0][1].scopes].sort()).toEqual(
      [
        "attachments:read",
        "attachments:write",
        "bot-invocations:read",
        "bot-invocations:write",
        "bot-runtime:read",
        "bot-runtime:write",
        "labels:read",
        "memos:read",
        "messages:read",
        "messages:write",
        "streams:read",
        "streams:write",
        "users:read",
      ].sort()
    )
  })

  it("summarises a key by the preset it matches, else by area and level", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([
      makeKey({ id: "uak_1", name: "Reader", scopes: ["messages:read", "streams:read", "streams:write"] }),
      makeKey({
        id: "uak_2",
        name: "Everything",
        scopes: [
          "messages:read",
          "messages:write",
          "messages:search",
          "streams:read",
          "streams:write",
          "docs:read",
          "docs:write",
          "attachments:read",
          "attachments:write",
          "users:read",
          "memos:read",
          "labels:read",
          "labels:write",
          "delegations:read",
          "delegations:write",
          "bot-runtime:read",
          "bot-runtime:write",
          "bot-invocations:read",
          "bot-invocations:write",
        ],
      }),
    ])

    renderSection()

    expect({
      reader: await screen.findByText("Messages · Read"),
      streams: screen.getByText("Streams · Write"),
      full: screen.getByText("Full access"),
    }).toEqual({ reader: expect.anything(), streams: expect.anything(), full: expect.anything() })
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

    await duplicate(user, "CI pipeline")

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
    expect(await screen.findByText("New key: CI pipeline (copy)")).toBeTruthy()
  })

  it("keeps an unpinned source key unpinned", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([makeKey({ apiVersion: null })])
    const create = vi
      .spyOn(workspacesApi, "createUserApiKey")
      .mockResolvedValue({ key: makeKey({ id: "uak_2" }), value: "threa_uk_new" })
    const user = userEvent.setup()

    renderSection()

    await duplicate(user, "CI pipeline")
    await user.click(screen.getByRole("button", { name: "Create key" }))

    await waitFor(() => expect(create).toHaveBeenCalledWith("ws_1", expect.objectContaining({ apiVersion: null })))
  })

  it("duplicating fills the form from that key and focuses its name; cancel discards it", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([
      makeKey({ scopes: ["messages:write", "bots:manage"], apiVersion: OLDER_API_VERSION }),
      makeKey({ id: "uak_3", name: "Laptop", scopes: ["messages:read"] }),
    ])
    const user = userEvent.setup()

    renderSection()

    await duplicate(user, "Laptop")

    const nameInput = screen.getByLabelText("Name") as HTMLInputElement
    await waitFor(() => expect(document.activeElement).toBe(nameInput))
    expect({
      name: nameInput.value,
      messagesRead: levelRadio("Messages", "Read").getAttribute("aria-checked"),
      droppedNote: screen.queryByText(/Not copied/),
    }).toEqual({
      name: "Laptop (copy)",
      messagesRead: "true",
      droppedNote: null,
    })

    await user.click(levelRadio("Messages", "Write"))
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await user.click(screen.getByRole("button", { name: "New key" }))

    expect({
      name: (screen.getByLabelText("Name") as HTMLInputElement).value,
      messagesNone: levelRadio("Messages", "None").getAttribute("aria-checked"),
    }).toEqual({ name: "", messagesNone: "true" })
  })

  it("clears a failed create's error once the draft is edited", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([makeKey()])
    vi.spyOn(workspacesApi, "createUserApiKey").mockRejectedValue(new Error("Key limit reached"))
    const user = userEvent.setup()

    renderSection()

    await duplicate(user, "CI pipeline")
    await user.click(screen.getByRole("button", { name: "Create key" }))
    expect((await screen.findByRole("alert")).textContent).toBe("Key limit reached")
    expect({
      scope: levelRadio("Messages", "Write").disabled,
      version: formVersionTrigger().disabled,
      cancel: (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    }).toEqual({ scope: false, version: false, cancel: false })

    await user.type(screen.getByLabelText("Name"), "!")

    expect(screen.queryByText("Key limit reached")).toBeNull()
  })

  it("clears a failed create's error when the form is closed and reopened", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([makeKey()])
    vi.spyOn(workspacesApi, "createUserApiKey").mockRejectedValue(new Error("Key limit reached"))
    const user = userEvent.setup()

    renderSection()

    await duplicate(user, "CI pipeline")
    await user.click(screen.getByRole("button", { name: "Create key" }))
    expect(await screen.findByText("Key limit reached")).toBeTruthy()

    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await user.click(screen.getByRole("button", { name: "New key" }))

    expect(screen.queryByText("Key limit reached")).toBeNull()
  })

  it("locks the dialog until an in-flight create settles", async () => {
    vi.spyOn(workspacesApi, "listUserApiKeys").mockResolvedValue([makeKey()])
    let resolveCreate!: (value: { key: UserApiKey; value: string }) => void
    vi.spyOn(workspacesApi, "createUserApiKey").mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    )
    const user = userEvent.setup()

    renderSection()

    await duplicate(user, "CI pipeline")
    await user.click(screen.getByRole("button", { name: "Create key" }))

    await waitFor(() =>
      expect({
        name: (screen.getByLabelText("Name") as HTMLInputElement).disabled,
        scope: levelRadio("Messages", "Write").disabled,
        version: formVersionTrigger().disabled,
        cancel: (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
      }).toEqual({ name: true, scope: true, version: true, cancel: true })
    )
    await user.keyboard("{Escape}")
    expect(screen.getByRole("dialog")).toBeTruthy()

    resolveCreate({ key: makeKey({ id: "uak_2", name: "CI pipeline (copy)" }), value: "threa_uk_new" })

    expect(await screen.findByText("New key: CI pipeline (copy)")).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })
})
