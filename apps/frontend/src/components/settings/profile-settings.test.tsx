import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, userEvent } from "@/test"
import * as authModule from "@/auth"
import * as hooksModule from "@/hooks"
import * as emojiModule from "@/hooks/use-workspace-emoji"
import * as workspaceStoreModule from "@/stores/workspace-store"
import { ProfileSettings } from "./profile-settings"

const USER = {
  id: "usr_1",
  workosUserId: "workos_1",
  name: "Ada Lovelace",
  email: "ada@example.com",
  avatarUrl: null,
  pronouns: "she/her",
  description: null,
  phone: null,
  githubUsername: "ada",
  statusEmoji: null,
  statusText: null,
  statusExpiresAt: null,
}

function mount() {
  const mutateAsync = vi.fn().mockResolvedValue(USER)
  vi.spyOn(authModule, "useAuth").mockReturnValue({ user: { id: "workos_1" } } as unknown as ReturnType<
    typeof authModule.useAuth
  >)
  vi.spyOn(workspaceStoreModule, "useWorkspaceUsers").mockReturnValue([USER] as unknown as ReturnType<
    typeof workspaceStoreModule.useWorkspaceUsers
  >)
  vi.spyOn(hooksModule, "useUpdateProfile").mockReturnValue({ mutateAsync, isPending: false } as unknown as ReturnType<
    typeof hooksModule.useUpdateProfile
  >)
  const idleMutation = { mutateAsync: vi.fn(), isPending: false }
  vi.spyOn(hooksModule, "useUploadAvatar").mockReturnValue(
    idleMutation as unknown as ReturnType<typeof hooksModule.useUploadAvatar>
  )
  vi.spyOn(hooksModule, "useRemoveAvatar").mockReturnValue(
    idleMutation as unknown as ReturnType<typeof hooksModule.useRemoveAvatar>
  )
  vi.spyOn(emojiModule, "useWorkspaceEmoji").mockReturnValue({
    toEmoji: (shortcode: string) => shortcode,
  } as unknown as ReturnType<typeof emojiModule.useWorkspaceEmoji>)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/w/ws_1"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<ProfileSettings />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
  return { mutateAsync }
}

describe("ProfileSettings", () => {
  afterEach(() => vi.restoreAllMocks())

  it("should render every profile setting at its own anchor, in two sections", () => {
    mount()
    const ids = ["avatar", "display-name", "status", "pronouns", "bio", "email", "phone", "github"]
    expect(ids.map((id) => document.getElementById(`setting-${id}`)?.dataset.setting)).toEqual(ids)
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Identity",
      "Contact details",
    ])
  })

  it("should save a changed display name on Enter, with no Save button", async () => {
    const { mutateAsync } = mount()
    const name = screen.getByRole("textbox", { name: "Display name" })
    await userEvent.clear(name)
    await userEvent.type(name, "  Ada King {Enter}")
    expect(mutateAsync).toHaveBeenCalledWith({ name: "Ada King" })
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
  })

  it("marks the display name required, and says so in place when a blank one puts the saved name back", async () => {
    const { mutateAsync } = mount()
    const name = screen.getByRole("textbox", { name: "Display name" })
    await userEvent.clear(name)
    await userEvent.tab()
    const errorId = name.getAttribute("aria-errormessage")
    const restored = {
      required: name.hasAttribute("required"),
      value: (name as HTMLInputElement).value,
      invalid: name.getAttribute("aria-invalid"),
      error: errorId ? document.getElementById(errorId)?.textContent : null,
      saves: mutateAsync.mock.calls.length,
    }
    await userEvent.type(name, "!")

    expect({ restored, typingClears: screen.queryByRole("alert") }).toEqual({
      restored: {
        required: true,
        value: "Ada Lovelace",
        invalid: "true",
        error: "Can't be empty, so the saved one is back.",
        saves: 0,
      },
      typingClears: null,
    })
  })

  it("should save contact fields on blur and clear one emptied", async () => {
    const { mutateAsync } = mount()
    await userEvent.type(screen.getByRole("textbox", { name: "Phone" }), "+46 70 000 00 00")
    await userEvent.tab()
    const github = screen.getByRole("textbox", { name: "GitHub username" })
    await userEvent.clear(github)
    await userEvent.tab()
    expect(mutateAsync.mock.calls).toEqual([[{ phone: "+46 70 000 00 00" }], [{ githubUsername: null }]])
  })

  it("should name the pronoun picker and the custom field", async () => {
    const { mutateAsync } = mount()
    await userEvent.click(screen.getByRole("combobox", { name: "Pronouns" }))
    await userEvent.click(await screen.findByRole("option", { name: "Custom" }))
    const custom = screen.getByRole("textbox", { name: "Custom pronouns" })
    expect(custom).toHaveValue("")
    await userEvent.type(custom, "ze/zir{Enter}")
    expect(mutateAsync).toHaveBeenCalledWith({ pronouns: "ze/zir" })
  })

  it("points the description and custom pronouns at their own save errors", async () => {
    const { mutateAsync } = mount()
    mutateAsync.mockRejectedValue(new Error("Couldn't save."))
    const description = screen.getByRole("textbox", { name: "Description" })
    await userEvent.type(description, "Engineer")
    await userEvent.tab()
    await userEvent.click(screen.getByRole("combobox", { name: "Pronouns" }))
    await userEvent.click(await screen.findByRole("option", { name: "Custom" }))
    const custom = screen.getByRole("textbox", { name: "Custom pronouns" })
    await userEvent.type(custom, "ze/zir{Enter}")

    const error = (field: HTMLElement) => {
      const id = field.getAttribute("aria-errormessage")
      return {
        invalid: field.getAttribute("aria-invalid"),
        role: id ? document.getElementById(id)?.getAttribute("role") : null,
      }
    }
    expect({ description: error(description), custom: error(custom) }).toEqual({
      description: { invalid: "true", role: "alert" },
      custom: { invalid: "true", role: "alert" },
    })
  })

  it("should say in place why the server refused a save, else that it couldn't save", async () => {
    const { mutateAsync } = mount()
    mutateAsync
      .mockRejectedValueOnce(new Error("GitHub username is not a valid handle"))
      .mockRejectedValueOnce(new Error(""))
    const github = screen.getByRole("textbox", { name: "GitHub username" })
    await userEvent.type(github, "!")
    await userEvent.tab()
    const refused = await screen.findByRole("alert")
    const reason = refused.textContent
    await userEvent.type(github, "?")
    await userEvent.tab()

    expect({ reason, generic: (await screen.findByRole("alert")).textContent }).toEqual({
      reason: "GitHub username is not a valid handle",
      generic: "Couldn't save your profile",
    })
  })

  it("shows the sign-in email as one truncated line of text, not a field, with why", () => {
    mount()
    const row = document.getElementById("setting-email")!
    const value = screen.getByText("ada@example.com")

    expect({
      field: screen.queryByRole("textbox", { name: "Email" }),
      text: row.textContent,
      oneLine: value.classList.contains("truncate"),
      title: value.closest("[title]"),
    }).toEqual({
      field: null,
      text: "EmailYour sign-in address. It can't be changed here.ada@example.com",
      oneLine: true,
      title: null,
    })
  })
})
