import { beforeEach, describe, expect, it, vi } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WORKSPACE_PERMISSION_SCOPES, type Workspace, type WorkspaceBootstrap } from "@threahq/types"
import { workspacesApi } from "@/api/workspaces"
import * as contextsModule from "@/contexts"
import { ServicesProvider } from "@/contexts"
import { formatTimezoneLabel } from "@/components/ui/timezone-picker"
// eslint-disable-next-line no-restricted-imports -- test seeds IDB directly to drive the real workspace store read
import { clearAllCachedData, db } from "@/db"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { GeneralTab } from "./general-tab"
import { TEST_WORKSPACE_ID, renderWorkspaceSettings } from "./test-harness"
import { toast } from "sonner"

async function seedWorkspace(region?: string, createdAt = new Date().toISOString()) {
  await db.workspaces.put({
    id: TEST_WORKSPACE_ID,
    name: "Acme",
    slug: "acme",
    region,
    createdAt,
    updatedAt: createdAt,
    _cachedAt: Date.now(),
  })
}

function renderTab(permissions: string[]) {
  return renderWorkspaceSettings(
    <ServicesProvider>
      <GeneralTab workspaceId={TEST_WORKSPACE_ID} />
    </ServicesProvider>,
    { permissions: permissions as never, settings: { billingTimezone: "Asia/Tokyo" }, route: "/?settings=workspace" }
  )
}

const ADMIN = [WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN]

describe("GeneralTab", () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { dateFormat: "DD/MM/YYYY" },
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
    await clearAllCachedData()
  })

  it("renames on Enter with the trimmed name and shows it everywhere the workspace is read", async () => {
    await seedWorkspace()
    const rename = vi
      .spyOn(workspacesApi, "rename")
      .mockImplementation(async (_id, name) => ({ id: TEST_WORKSPACE_ID, name }) as Workspace)
    const user = userEvent.setup()
    const { queryClient } = renderTab(ADMIN)
    queryClient.setQueryData(workspaceKeys.bootstrap(TEST_WORKSPACE_ID), (old: WorkspaceBootstrap) => ({
      ...old,
      workspace: { id: TEST_WORKSPACE_ID, name: "Acme" },
    }))

    const input = await screen.findByRole("textbox", { name: "Workspace name" })
    await waitFor(() => expect(input).toHaveValue("Acme"))
    await user.clear(input)
    await user.type(input, "  Acme Research  {Enter}")

    await waitFor(async () =>
      expect({
        calls: rename.mock.calls,
        field: (input as HTMLInputElement).value,
        stored: (await db.workspaces.get(TEST_WORKSPACE_ID))?.name,
        bootstrap: queryClient.getQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(TEST_WORKSPACE_ID))?.workspace
          .name,
      }).toEqual({
        calls: [[TEST_WORKSPACE_ID, "Acme Research"]],
        field: "Acme Research",
        stored: "Acme Research",
        bootstrap: "Acme Research",
      })
    )
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument()
  })

  it("reverts an edit on Escape without closing anything", async () => {
    await seedWorkspace()
    const user = userEvent.setup()
    renderTab(ADMIN)

    const input = await screen.findByRole("textbox", { name: "Workspace name" })
    await waitFor(() => expect(input).toHaveValue("Acme"))
    await user.type(input, " Labs")
    const outerEscape = vi.fn()
    document.addEventListener("keydown", outerEscape, { capture: true })
    await user.keyboard("{Escape}")
    document.removeEventListener("keydown", outerEscape, { capture: true })

    expect({ value: (input as HTMLInputElement).value, outerEscape: outerEscape.mock.calls.length }).toEqual({
      value: "Acme",
      outerEscape: 0,
    })
  })

  it("saves on blur, ignores a blank name, and shows a failure in place", async () => {
    await seedWorkspace()
    const rename = vi.spyOn(workspacesApi, "rename").mockRejectedValue(new Error("boom"))
    const toastError = vi.spyOn(toast, "error")
    const user = userEvent.setup()
    renderTab(ADMIN)

    const input = await screen.findByRole("textbox", { name: "Workspace name" })
    await waitFor(() => expect(input).toHaveValue("Acme"))
    await user.clear(input)
    await user.tab()
    expect({ calls: rename.mock.calls.length, value: (input as HTMLInputElement).value }).toEqual({
      calls: 0,
      value: "Acme",
    })

    await user.type(input, " Labs")
    await user.tab()
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't rename the workspace")
    expect({
      value: (input as HTMLInputElement).value,
      invalid: input.getAttribute("aria-invalid"),
      toasted: toastError.mock.calls.length,
    }).toEqual({
      value: "Acme Labs",
      invalid: "true",
      toasted: 0,
    })
  })

  it("shows a non-admin the name read-only with the reason", async () => {
    await seedWorkspace()
    renderTab([])

    expect(await screen.findByText("Acme")).toBeInTheDocument()
    expect({
      textbox: screen.queryByRole("textbox"),
      reason: screen.getByText("Only admins can rename the workspace.").tagName,
    }).toEqual({ textbox: null, reason: "SPAN" })
  })

  it("names the region the workspace's data lives in", async () => {
    await seedWorkspace("eu-north-1")
    renderTab([])

    expect(await screen.findByText("Europe (Stockholm)")).toBeInTheDocument()
  })

  it("should show a non-admin the workspace's time zone and creation date, read-only", async () => {
    await seedWorkspace(undefined, new Date(2025, 2, 14, 12).toISOString())
    renderTab([])

    expect(await screen.findByText("14/03/2025")).toBeInTheDocument()
    expect({
      timezone: screen.getByText(formatTimezoneLabel("Asia/Tokyo")).tagName,
      picker: screen.queryByRole("combobox"),
    }).toEqual({ timezone: "SPAN", picker: null })
  })

  it("should let an admin pick the workspace's time zone", async () => {
    await seedWorkspace()
    renderTab(ADMIN)

    expect(await screen.findByRole("combobox")).toHaveTextContent(/Asia\/Tokyo/)
  })
})
