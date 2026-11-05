import { useEffect, useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Link, MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WORKSPACE_PERMISSION_SCOPES, type SettingsTab } from "@threahq/types"
import { SettingsProvider } from "@/contexts"
import * as contextsModule from "@/contexts"
import * as useMobileModule from "@/hooks/use-mobile"
import * as useWorkspacesModule from "@/hooks/use-workspaces"
import * as useFeatureFlagsModule from "@/hooks/use-feature-flags"
import { DEFAULT_USER_PREFERENCES } from "@threahq/types"
import { clearStreamMemberships, clearStreams, seedStream, seedStreamMembership } from "@/test/workspace-rows"
import { SettingsDialog } from "./settings-dialog"
import { KeyboardSettings } from "./keyboard-settings"
import * as settingsPagesModule from "./settings-pages"
import * as streamSettingsPageModule from "@/components/stream-settings/stream-settings-dialog"
import { SETTINGS_PAGE_CONFIG } from "./settings-registry"
import { SettingsLink } from "@/components/workspace-settings/settings-link"

/** Stands in for the browser's Back button, which MemoryRouter has none of. */
let goBack: () => void = () => {}

function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    goBack = () => navigate(-1)
  }, [navigate])
  return <output data-testid="location">{location.search}</output>
}

async function seedChannel() {
  await seedStream("ws_1", "stream_1", { slug: "design", displayName: null })
}

let captureOnKeyboardPage = false
let linkPreviewSection = false
let linkPreviewsFirst = false
let draftOnPage = false
let settingLinkOnPage = false

function DraftField() {
  const [draft, setDraft] = useState("")
  return <input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
}

/** Makes every scroller's content taller than its box, as a long page is. */
function tallPages() {
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(2000)
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600)
}

function SettingsOpener() {
  return <Link to="?settings=">Open settings</Link>
}

function renderWindow(search: string, path = "/w/ws_1/s/stream_1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`${path}${search}`]}>
        <Routes>
          <Route
            path="/w/:workspaceId/*"
            element={
              <SettingsProvider>
                <SettingsOpener />
                <SettingsDialog />
                <LocationProbe />
              </SettingsProvider>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

function LinkPreviewsSection() {
  return (
    <section aria-labelledby="settings-section-link-previews" data-below-the-top="">
      <h3 id="settings-section-link-previews" tabIndex={-1}>
        Link previews
      </h3>
      <div id="setting-link-preview-count" data-setting="link-preview-count" tabIndex={-1}>
        Preview count row
      </div>
    </section>
  )
}

function StubPage({
  tab,
  onShortcutCaptureChange,
}: {
  tab: SettingsTab
  onShortcutCaptureChange: (capturing: boolean) => void
}) {
  useEffect(() => {
    if (tab !== "keyboard" || !captureOnKeyboardPage) return
    onShortcutCaptureChange(true)
    return () => onShortcutCaptureChange(false)
  }, [tab, onShortcutCaptureChange])
  return (
    <div>
      <p>{SETTINGS_PAGE_CONFIG[tab].label} page</p>
      <div id="setting-theme" tabIndex={-1}>
        Theme row
      </div>
      {tab === "messages" && linkPreviewSection && linkPreviewsFirst && <LinkPreviewsSection />}
      {tab === "messages" && linkPreviewSection && (
        <section aria-labelledby="settings-section-opening">
          <h3 id="settings-section-opening" tabIndex={-1}>
            Opening streams
          </h3>
        </section>
      )}
      {tab === "messages" && linkPreviewSection && !linkPreviewsFirst && <LinkPreviewsSection />}
      {draftOnPage && <DraftField />}
      {settingLinkOnPage && <SettingsLink setting="pronouns">Pronouns</SettingsLink>}
    </div>
  )
}

describe("SettingsDialog", () => {
  afterEach(async () => {
    await clearStreams()
    await clearStreamMemberships()
  })

  beforeEach(() => {
    vi.restoreAllMocks()
    captureOnKeyboardPage = false
    linkPreviewSection = false
    linkPreviewsFirst = false
    draftOnPage = false
    settingLinkOnPage = false
    vi.spyOn(settingsPagesModule, "SettingsPage").mockImplementation((props) => <StubPage {...props} />)
    vi.spyOn(useWorkspacesModule, "useViewerPermissions").mockReturnValue([])
    vi.spyOn(useWorkspacesModule, "useCurrentWorkspaceUser").mockReturnValue(null)
    vi.spyOn(streamSettingsPageModule, "StreamSettingsPage").mockImplementation(({ tab }) => <p>Stream {tab} page</p>)
  })

  it("opens on an overview of both groups with search focused", async () => {
    renderWindow("?settings=")

    const overview = await screen.findByRole("region", { name: "You" })
    expect(within(overview).getByRole("link", { name: /^Appearance/ })).toHaveTextContent(
      SETTINGS_PAGE_CONFIG.appearance.covers
    )
    expect(screen.getByRole("region", { name: "Workspace" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 2, name: "Overview" })).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Search settings" })).toHaveFocus()
    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("aria-current", "page")
  })

  it("holds the overview, heading and all, until permissions are known", async () => {
    vi.spyOn(useWorkspacesModule, "useViewerPermissions").mockReturnValue(undefined)
    renderWindow("?settings=")

    await screen.findByRole("combobox", { name: "Search settings" })
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull()
    expect(screen.queryByRole("region", { name: "You" })).toBeNull()
  })

  it("holds an admin page's place in the nav while permissions load", async () => {
    vi.spyOn(useWorkspacesModule, "useViewerPermissions").mockReturnValue(undefined)
    renderWindow("?settings=appearance")

    const nav = await screen.findByRole("navigation", { name: "Settings pages" })
    const workspacePages = within(nav).getByRole("list", { name: "Workspace" })
    const placeholders = within(workspacePages)
      .getAllByRole("listitem")
      .filter((item) => within(item).queryByRole("link") === null)
    expect(placeholders).toHaveLength(1)
    // The row it becomes, drawn inert so nothing pops in, hidden from assistive tech while aria-busy says why.
    expect(placeholders[0].textContent).toContain("Workspace AI")
    expect(placeholders[0].firstElementChild).toHaveAttribute("aria-hidden", "true")
    expect(within(nav).queryByRole("link", { name: /Workspace AI/ })).toBeNull()
    expect(nav).toHaveAttribute("aria-busy", "true")
  })

  it("shows a workspace page's skeleton, not its controls, until permissions are known", async () => {
    vi.spyOn(useWorkspacesModule, "useViewerPermissions").mockReturnValue(undefined)
    renderWindow("?settings=workspace")

    await screen.findByRole("heading", { level: 2, name: "Workspace details" })
    expect(screen.queryByText("Workspace details page")).toBeNull()
  })

  it("marks admin-only pages for admins, in the nav and on the overview", async () => {
    vi.spyOn(useWorkspacesModule, "useViewerPermissions").mockReturnValue(Object.values(WORKSPACE_PERMISSION_SCOPES))
    renderWindow("?settings=")

    const nav = await screen.findByRole("navigation", { name: "Settings pages" })
    expect(nav).not.toHaveAttribute("aria-busy")
    const adminPage = within(nav).getByRole("link", { name: "Workspace AI" })
    expect(adminPage).toHaveTextContent("Admins")
    // jsdom's accname skips aria-hidden nodes a description references; browsers read them.
    expect(document.getElementById(adminPage.getAttribute("aria-describedby") ?? "")).toHaveTextContent("Admins only")
    const workspace = screen.getByRole("region", { name: "Workspace" })
    expect(within(workspace).getByRole("link", { name: /Workspace AI/ })).toHaveTextContent("Admins")
    expect(within(workspace).getByRole("link", { name: /Members/ })).not.toHaveTextContent("Admins")
    expect(screen.queryAllByText("View only")).toEqual([])
  })

  it("marks the workspace pages a member can open but not change as view only, before they open them", async () => {
    vi.spyOn(useWorkspacesModule, "useViewerPermissions").mockReturnValue([WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE])
    renderWindow("?settings=")

    const nav = await screen.findByRole("navigation", { name: "Settings pages" })
    const navWorkspace = within(nav).getByRole("link", { name: "Workspace details" })
    expect(navWorkspace).toHaveTextContent("View only")
    expect(document.getElementById(navWorkspace.getAttribute("aria-describedby") ?? "")).toHaveTextContent("View only")
    expect(within(nav).getByRole("link", { name: "Members" })).not.toHaveTextContent("View only")
    expect(within(nav).queryByRole("link", { name: /Workspace AI/ })).toBeNull()
    const workspace = screen.getByRole("region", { name: "Workspace" })
    expect(within(workspace).getByRole("link", { name: /^Shared bots/ })).toHaveTextContent("View only")
    expect(within(workspace).getByRole("link", { name: /^Members/ })).not.toHaveTextContent("View only")
    expect(within(screen.getByRole("region", { name: "You" })).queryByText("View only")).toBeNull()
  })

  it("offers section jumps on a page of three or more sections taller than the window", async () => {
    const short = renderWindow("?settings=messages")
    await screen.findByText("Reading page")
    expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull()
    short.unmount()

    tallPages()
    const voice = renderWindow("?settings=voice")
    await screen.findByText("Voice & calls page")
    expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull()
    voice.unmount()

    const { unmount } = renderWindow("?settings=messages")

    const jumps = await screen.findByRole("navigation", { name: "On this page" })
    expect(within(jumps).getByRole("button", { name: "Opening streams" })).toHaveAttribute("aria-current", "location")
    unmount()

    const keyboard = renderWindow("?settings=keyboard")
    expect(
      within(await screen.findByRole("navigation", { name: "On this page" }))
        .getAllByRole("button")
        .map((button) => button.textContent)
    ).toEqual(["Sending", "Composer", "Shortcuts", "Navigation shortcuts", "View shortcuts", "Editing shortcuts"])
    keyboard.unmount()

    renderWindow("?settings=workspace")
    await screen.findByText("Workspace details page")
    expect(screen.queryByRole("navigation", { name: "On this page" })).toBeNull()
  })

  it("lists a page's sections in the order the page renders them", async () => {
    tallPages()
    linkPreviewSection = true
    linkPreviewsFirst = true
    renderWindow("?settings=messages")

    const jumps = await screen.findByRole("navigation", { name: "On this page" })
    await waitFor(() =>
      expect(
        within(jumps)
          .getAllByRole("button")
          .slice(0, 2)
          .map((button) => button.textContent)
      ).toEqual(["Link previews", "Opening streams"])
    )
  })

  it("lists Early access last among your pages, only for a viewer with a feature on early", async () => {
    const { unmount } = renderWindow("?settings=")
    const nav = await screen.findByRole("navigation", { name: "Settings pages" })
    expect(within(nav).queryByRole("link", { name: "Early access" })).toBeNull()
    unmount()

    vi.spyOn(useFeatureFlagsModule, "useOverriddenFeatureFlags").mockReturnValue([
      { key: "search", value: "on", defaultValue: "off", scope: "user" },
    ])
    renderWindow("?settings=")
    const yours = within(await screen.findByRole("navigation", { name: "Settings pages" })).getByRole("list", {
      name: "You",
    })
    expect(within(yours).getAllByRole("link").at(-1)).toHaveAccessibleName("Early access")
  })

  it("marks the section a link landed in as the one being read", async () => {
    tallPages()
    linkPreviewSection = true
    // The landed row is centred in view while its section's top sits further down than the spy's offset.
    const rect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-below-the-top") ? new DOMRect(0, 900, 0, 100) : rect.call(this)
    })
    renderWindow("?settings=messages&setting=link-preview-count")

    const jumps = await screen.findByRole("navigation", { name: "On this page" })
    await waitFor(() =>
      expect(within(jumps).getByRole("button", { name: "Link previews" })).toHaveAttribute("aria-current", "location")
    )
  })

  it("returns focus to what opened it when it closes", async () => {
    const user = userEvent.setup()
    renderWindow("", "/w/ws_1")

    await user.click(screen.getByRole("link", { name: "Open settings" }))
    await screen.findByRole("dialog")
    await user.keyboard("{Escape}")

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.getByRole("link", { name: "Open settings" })).toHaveFocus()
  })

  it("offers stream pages with no stream in view, each asking which stream", async () => {
    renderWindow("?settings=", "/w/ws_1")

    const streams = await screen.findByRole("region", { name: "Stream settings" })
    expect(within(streams).getByRole("link", { name: /^General/ })).toHaveAttribute(
      "href",
      "/w/ws_1?stream-settings=general"
    )
  })

  it("lists threads in the stream picker under the stream they belong to", async () => {
    await seedChannel()
    await seedStreamMembership("ws_1", "stream_1")
    await seedStream("ws_1", "stream_2", {
      type: "thread",
      parentStreamId: "stream_1",
      rootStreamId: "stream_1",
      displayName: "Launch plan",
    })
    renderWindow("?stream-settings=general", "/w/ws_1")

    expect(await screen.findByRole("link", { name: /#design › Launch plan/ })).toHaveAttribute(
      "href",
      "/w/ws_1?stream-settings=general&sid=stream_2"
    )
  })

  it("lists a public channel the viewer hasn't joined and its threads, but not a private one", async () => {
    await seedChannel()
    await seedStream("ws_1", "stream_2", {
      type: "thread",
      parentStreamId: "stream_1",
      rootStreamId: "stream_1",
      displayName: "Launch plan",
    })
    await seedStream("ws_1", "stream_3", { slug: "secret", visibility: "private" })
    await seedStream("ws_1", "stream_4", {
      type: "thread",
      parentStreamId: "stream_3",
      rootStreamId: "stream_3",
      displayName: "Hidden plan",
    })
    await seedStreamMembership("ws_1", "stream_4")
    renderWindow("?stream-settings=general", "/w/ws_1")

    expect(await screen.findByRole("link", { name: /#design › Launch plan/ })).toHaveAttribute(
      "href",
      "/w/ws_1?stream-settings=general&sid=stream_2"
    )
    expect(screen.getByRole("link", { name: /^#design$/ })).toHaveAttribute(
      "href",
      "/w/ws_1?stream-settings=general&sid=stream_1"
    )
    expect(screen.queryByRole("link", { name: /secret|Hidden plan/ })).toBeNull()
  })

  it("reads a thread left on its default as the level it inherits from its stream", async () => {
    await seedChannel()
    await seedStreamMembership("ws_1", "stream_1", { notificationLevel: "muted" })
    await seedStream("ws_1", "stream_2", {
      type: "thread",
      parentStreamId: "stream_1",
      rootStreamId: "stream_1",
      displayName: "Launch plan",
    })
    await seedStreamMembership("ws_1", "stream_2")
    renderWindow("?settings=", "/w/ws_1/s/stream_2")

    const thread = await screen.findByRole("region", { name: /^This stream/ })
    await waitFor(() =>
      expect(within(thread).getByRole("link", { name: /^General/ })).toHaveTextContent("Notify: thread default · muted")
    )
  })

  it("sets a short query's neighbours apart under Related", async () => {
    const user = userEvent.setup()
    renderWindow("?settings=")

    await user.type(await screen.findByRole("combobox", { name: "Search settings" }), "preview")
    const related = await screen.findByRole("group", { name: "Related" })
    expect(within(related).getAllByRole("option").length).toBeGreaterThan(0)
    expect(screen.getByText("↑↓ choose · Enter open")).toBeInTheDocument()
  })

  it("asks which stream a stream setting found with no stream in view opens on", async () => {
    await seedChannel()
    await seedStreamMembership("ws_1", "stream_1")
    const user = userEvent.setup()
    renderWindow("?settings=", "/w/ws_1")

    await user.type(await screen.findByRole("combobox", { name: "Search settings" }), "mute channel")
    expect(await screen.findByRole("option", { name: /Notify me about/ })).toHaveTextContent(
      "Any stream › General › Your notifications"
    )
    await user.keyboard("{Enter}")
    expect(screen.getByTestId("location").textContent).toBe("?stream-settings=general&setting=stream-notifications")
    expect(await screen.findByRole("heading", { level: 2, name: "Choose a stream" })).toBeInTheDocument()

    await user.click(await screen.findByRole("link", { name: /#design/ }))
    expect(screen.getByTestId("location").textContent).toBe(
      "?stream-settings=general&setting=stream-notifications&sid=stream_1"
    )
    expect(await screen.findByText("Stream general page")).toBeVisible()
  })

  it("should ask which stream a stream page opens on when the route is a draft", async () => {
    await seedChannel()
    await seedStreamMembership("ws_1", "stream_1")
    renderWindow("?stream-settings=general&setting=stream-notifications", "/w/ws_1/s/draft_1")

    expect(await screen.findByRole("heading", { level: 2, name: "Choose a stream" })).toBeInTheDocument()
    expect(await screen.findByRole("link", { name: /#design/ })).toBeInTheDocument()
  })

  it("should ask which stream once the stream a link names turns out to be gone", async () => {
    await seedChannel()
    await seedStreamMembership("ws_1", "stream_1")
    renderWindow("?stream-settings=general&sid=stream_gone", "/w/ws_1/s/stream_gone")

    expect(await screen.findByRole("heading", { level: 2, name: "Choose a stream" })).toBeInTheDocument()
    expect(await screen.findByRole("link", { name: /#design/ })).toBeInTheDocument()
  })

  it("lists settings changed from their default, with a reset that writes the default back", async () => {
    const updatePreferences = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(contextsModule, "usePreferencesOptional").mockReturnValue({
      preferences: { ...DEFAULT_USER_PREFERENCES, theme: "dark" },
      updatePreferences,
    } as unknown as ReturnType<typeof contextsModule.usePreferencesOptional>)
    const user = userEvent.setup()
    renderWindow("?settings=")

    await user.click(await screen.findByRole("button", { name: /Changed from default/ }))
    const changed = screen.getByRole("list", { name: "Changed from default" })
    expect(within(changed).getByRole("link", { name: /Theme/ })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_1?settings=appearance&setting=theme"
    )
    await user.click(within(changed).getByRole("button", { name: "Reset Theme" }))

    expect(updatePreferences).toHaveBeenCalledWith({ theme: DEFAULT_USER_PREFERENCES.theme })
  })

  it("points search at its results only while they exist, and clears with its own button", async () => {
    const user = userEvent.setup()
    renderWindow("?settings=")

    const search = await screen.findByRole("combobox", { name: "Search settings" })
    expect(search).not.toHaveAttribute("aria-controls")
    await user.type(search, "theme")
    expect(search).toHaveAttribute("aria-controls", screen.getByRole("listbox", { name: "Settings" }).id)

    await user.click(screen.getByRole("button", { name: "Clear search" }))
    expect(search).toHaveValue("")
    expect(search).toHaveFocus()
    expect(search).not.toHaveAttribute("aria-controls")
  })

  it("finds a setting by the symptom a user describes and lands on its row", async () => {
    const user = userEvent.setup()
    renderWindow("?settings=")

    await user.type(await screen.findByRole("combobox", { name: "Search settings" }), "dark mode")
    expect(await screen.findByRole("option", { name: /Theme/ })).toBeInTheDocument()

    await user.keyboard("{Enter}")

    expect(screen.getByTestId("location")).toHaveTextContent("?settings=appearance&setting=theme")
    expect(await screen.findByText("Appearance page")).toBeVisible()
  })

  it("clears the shortcut filter when search lands on a shortcut it hides", async () => {
    vi.spyOn(contextsModule, "usePreferences").mockReturnValue({
      preferences: { keyboardShortcuts: {}, messageSendMode: "enter", accessibility: {} },
      updatePreference: vi.fn(),
      updateAccessibility: vi.fn(),
    } as unknown as ReturnType<typeof contextsModule.usePreferences>)
    vi.spyOn(settingsPagesModule, "SettingsPage").mockImplementation((props) =>
      props.tab === "keyboard" ? <KeyboardSettings /> : <StubPage {...props} />
    )
    const user = userEvent.setup()
    renderWindow("?settings=keyboard&setting=shortcut-formatBold")

    await user.type(await screen.findByRole("searchbox", { name: "Filter shortcuts" }), "sidebar")
    expect(screen.queryByRole("button", { name: /^Change shortcut for Bold,/ })).toBeNull()
    await user.type(screen.getByRole("combobox", { name: "Search settings" }), "bold")
    await user.click(await screen.findByRole("option", { name: /^Bold/ }))

    expect(screen.getByRole("searchbox", { name: "Filter shortcuts" })).toHaveValue("")
    await waitFor(() => expect(document.getElementById("setting-shortcut-formatBold")).toHaveFocus())
  })

  it("focuses and highlights the setting a link names", async () => {
    renderWindow("?settings=appearance&setting=theme")

    const row = await screen.findByText("Theme row")
    await waitFor(() => expect(row).toHaveFocus())
    expect(row).toHaveAttribute("data-highlighted", "true")
  })

  it("marks the open page in the navigation", async () => {
    const user = userEvent.setup()
    renderWindow("?settings=appearance")

    const nav = await screen.findByRole("navigation", { name: "Settings pages" })
    expect(within(nav).getByRole("link", { name: "Appearance" })).toHaveAttribute("aria-current", "page")

    await user.click(within(nav).getByRole("link", { name: "Members" }))

    expect(screen.getByTestId("location")).toHaveTextContent("?settings=members")
    expect(await screen.findByRole("heading", { level: 2, name: "Members" })).toHaveFocus()
  })

  it("opens a legacy workspace settings link on the page it became", async () => {
    renderWindow("?ws-settings=users")

    expect(await screen.findByText("Members page")).toBeVisible()
    expect(screen.getByTestId("location")).toHaveTextContent("?settings=members")
  })

  it("clears a search on Escape before closing the window", async () => {
    const user = userEvent.setup()
    renderWindow("?settings=")

    const search = await screen.findByRole("combobox", { name: "Search settings" })
    await user.type(search, "preview")
    await user.keyboard("{Escape}")

    expect(search).toHaveValue("")
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    await user.keyboard("{Escape}")
    await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("settings="))
  })

  it("does not close on Escape while a shortcut is being captured", async () => {
    const user = userEvent.setup()
    captureOnKeyboardPage = true
    renderWindow("?settings=keyboard")

    await screen.findByText("Keyboard & composer page")
    await user.keyboard("{Escape}")

    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByTestId("location")).toHaveTextContent("?settings=keyboard")
  })

  it("moves the active result with the arrow keys and opens it with Enter", async () => {
    const user = userEvent.setup()
    renderWindow("?settings=")

    const search = await screen.findByRole("combobox", { name: "Search settings" })
    await user.type(search, "collapse")
    const options = within(screen.getByRole("listbox", { name: "Settings" })).getAllByRole("option")
    expect(search).toHaveAttribute("aria-activedescendant", options[0].id)
    expect(options[0]).toHaveAttribute("aria-selected", "true")

    await user.keyboard("{ArrowDown}")
    expect(search).toHaveAttribute("aria-activedescendant", options[1].id)
    await user.keyboard("{ArrowUp}{ArrowUp}")
    expect(search).toHaveAttribute("aria-activedescendant", options[options.length - 1].id)

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}")
    expect(screen.getByTestId("location")).toHaveTextContent(
      new URL(options[1].getAttribute("href")!, "http://x").search
    )
  })

  it("reaches the results with Tab past the search field, and chooses there with the arrows", async () => {
    const user = userEvent.setup()
    renderWindow("?settings=")

    await user.type(await screen.findByRole("combobox", { name: "Search settings" }), "collapse")
    const list = screen.getByRole("listbox", { name: "Settings" })
    const options = within(list).getAllByRole("option")
    for (let step = 0; step < 60 && document.activeElement !== list; step++) await user.tab()
    expect(list).toHaveFocus()
    expect(list).toHaveAttribute("aria-activedescendant", options[0].id)

    await user.keyboard("{ArrowDown}")
    expect(list).toHaveAttribute("aria-activedescendant", options[1].id)
    await user.keyboard("{Enter}")
    expect(screen.getByTestId("location")).toHaveTextContent(
      new URL(options[1].getAttribute("href")!, "http://x").search
    )
  })

  it("names where a result lives and clears the current page while results show", async () => {
    const user = userEvent.setup()
    renderWindow("?settings=appearance")

    const nav = await screen.findByRole("navigation", { name: "Settings pages" })
    await user.type(screen.getByRole("combobox", { name: "Search settings" }), "previews to expand")

    expect(await screen.findByRole("option", { name: /Previews to expand/ })).toHaveTextContent(
      "You › Reading › Link previews"
    )
    expect(within(nav).queryByRole("link", { current: "page" })).toBeNull()
  })

  it("focuses search on / unless typing in a field", async () => {
    const user = userEvent.setup()
    renderWindow("?settings=")

    const search = await screen.findByRole("combobox", { name: "Search settings" })
    screen.getByRole("link", { name: "Overview" }).focus()
    await user.keyboard("/")
    expect(search).toHaveFocus()
    expect(search).toHaveValue("")

    await user.keyboard("/")
    expect(search).toHaveValue("/")
  })

  it("takes the search-in-stream chord from anywhere in the window, selecting what was typed", async () => {
    const user = userEvent.setup()
    renderWindow("?settings=appearance")
    const reachedDocument = vi.fn()
    document.addEventListener("keydown", reachedDocument)

    const search = await screen.findByRole<HTMLInputElement>("combobox", { name: "Search settings" })
    await user.type(search, "theme")
    screen.getByRole("link", { name: "Overview" }).focus()
    await user.keyboard("{Control>}f{/Control}")
    document.removeEventListener("keydown", reachedDocument)

    expect(search).toHaveFocus()
    expect([search.selectionStart, search.selectionEnd]).toEqual([0, "theme".length])
    expect(reachedDocument).not.toHaveBeenCalledWith(expect.objectContaining({ key: "f" }))
  })

  it("keeps the open page, and what was typed on it, behind search results", async () => {
    draftOnPage = true
    const user = userEvent.setup()
    renderWindow("?settings=appearance")

    await user.type(await screen.findByRole("textbox", { name: "Draft" }), "half a thought")
    const search = screen.getByRole("combobox", { name: "Search settings" })
    await user.type(search, "theme")
    expect(screen.queryByRole("textbox", { name: "Draft" })).toBeNull()

    await user.click(screen.getByRole("button", { name: "Clear search" }))
    expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("half a thought")
  })

  it("sets apart what already holds a chord the query names", async () => {
    const user = userEvent.setup()
    renderWindow("?settings=")

    await user.type(await screen.findByRole("combobox", { name: "Search settings" }), "change bold from cmd+b to cmd+f")
    const taken = await screen.findByRole("group", { name: "Keys already in use" })
    expect(within(taken).getByRole("option", { name: /Search in stream/ })).toBeInTheDocument()
    expect(within(taken).queryByRole("option", { name: /Bold/ })).toBeNull()
  })

  it("lists your pages, then the workspace's, with no stream in view", async () => {
    renderWindow("?settings=", "/w/ws_1")

    const nav = await screen.findByRole("navigation", { name: "Settings pages" })
    expect(
      within(nav)
        .getAllByRole("list")
        .map((list) => document.getElementById(list.getAttribute("aria-labelledby") ?? "")?.textContent)
    ).toEqual(["You", "Workspace"])
  })

  it("offers the settings of the stream it was opened from, in search and on the overview", async () => {
    await seedChannel()
    const user = userEvent.setup()
    renderWindow("?settings=")

    const streamCard = await screen.findByRole("region", { name: "This stream · #design" })
    expect(
      streamCard.compareDocumentPosition(screen.getByRole("region", { name: "You" })) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    const nav = screen.getByRole("navigation", { name: "Settings pages" })
    expect(
      within(nav)
        .getAllByRole("list")
        .map((list) => document.getElementById(list.getAttribute("aria-labelledby") ?? "")?.textContent)
    ).toEqual(["This stream · #design", "You", "Workspace"])
    expect(within(streamCard).getByRole("link", { name: /^Stream members/ })).toHaveAttribute(
      "href",
      "/w/ws_1/s/stream_1?stream-settings=members&sid=stream_1"
    )

    await user.type(screen.getByRole("combobox", { name: "Search settings" }), "mute channel")
    expect(await screen.findByRole("option", { name: /Notify me about/ })).toHaveTextContent(
      "#design › General › Your notifications"
    )
    await user.keyboard("{Enter}")
    expect(screen.getByTestId("location").textContent).toBe(
      "?stream-settings=general&sid=stream_1&setting=stream-notifications"
    )
    expect(await screen.findByText("Stream general page")).toBeVisible()
    expect(screen.getByRole("heading", { level: 2, name: "General" })).toBeInTheDocument()
  })

  describe("on a phone", () => {
    // jsdom has no Element.scrollTo.
    const scrollTo = vi.fn()

    beforeEach(() => {
      vi.spyOn(useMobileModule, "useIsMobile").mockReturnValue(true)
      scrollTo.mockReset()
      Object.defineProperty(Element.prototype, "scrollTo", { value: scrollTo, configurable: true, writable: true })
    })

    afterEach(() => {
      delete (Element.prototype as Partial<Element>).scrollTo
    })

    it("pushes a page opened from the index, so Back returns to the index", async () => {
      renderWindow("?settings=")

      const index = await screen.findByRole("region", { name: "You" })
      fireEvent.click(within(index).getByRole("link", { name: /^Appearance/ }))
      expect(screen.getByTestId("location")).toHaveTextContent("?settings=appearance")
      expect(await screen.findByText("Appearance page")).toBeInTheDocument()

      act(() => goBack())
      expect(screen.getByTestId("location").textContent).toBe("?settings=")
      expect(await screen.findByRole("region", { name: "You" })).toBeInTheDocument()
    })

    it("opens a page with its heading focused, so the page is announced", async () => {
      renderWindow("?settings=appearance")

      await waitFor(() => expect(screen.getByRole("heading", { level: 2, name: "Appearance" })).toHaveFocus())
    })

    it("surveys every scope in one scroll, with a jump to each", async () => {
      await seedChannel()
      renderWindow("?settings=")

      const scopes = await screen.findByRole("navigation", { name: "Settings scope" })
      expect(await screen.findByRole("region", { name: "This stream · #design" })).toBeInTheDocument()
      expect(
        within(scopes)
          .getAllByRole("button")
          .map((chip) => chip.textContent)
      ).toEqual(["This stream", "You", "Workspace"])
      expect(screen.getByRole("region", { name: "You" })).toBeInTheDocument()
      const workspace = screen.getByRole("region", { name: "Workspace" })

      fireEvent.click(within(scopes).getByRole("button", { name: "Workspace" }))

      expect(within(workspace).getAllByRole("link")[0]).toHaveFocus()
      expect(within(scopes).getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-current", "location")
      expect(within(scopes).getByRole("button", { name: "You" })).not.toHaveAttribute("aria-current")
      // The strip sits outside the scroll, so it never scrolls away.
      expect(workspace.closest(".overflow-y-auto")?.contains(scopes)).toBe(false)
    })

    it("jumps within the window's own scroll and keeps the jumped scope current while content arrives above it", async () => {
      await seedChannel()
      renderWindow("?settings=")

      const scopes = await screen.findByRole("navigation", { name: "Settings scope" })
      await screen.findByRole("region", { name: "This stream · #design" })
      const workspace = screen.getByRole("region", { name: "Workspace" })
      const scroller = workspace.closest<HTMLElement>(".overflow-y-auto")!
      const rect = HTMLElement.prototype.getBoundingClientRect
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this === workspace) return new DOMRect(0, 800, 300, 400)
        if (this === scroller) return new DOMRect(0, 100, 300, 600)
        return rect.call(this)
      })

      fireEvent.click(within(scopes).getByRole("button", { name: "Workspace" }))
      expect(scrollTo.mock.contexts).toEqual([scroller])
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 700 }))

      // A late row above, such as a changed setting, pushes the scope down; it stays pinned and current.
      act(() => scroller.firstElementChild?.prepend(document.createElement("div")))
      await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(2))
      expect(scrollTo.mock.contexts).toEqual([scroller, scroller])
      expect(within(scopes).getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-current", "location")
    })

    it("marks the last scope current once the scroll reaches the end", async () => {
      await seedChannel()
      renderWindow("?settings=")

      const scopes = await screen.findByRole("navigation", { name: "Settings scope" })
      await screen.findByRole("region", { name: "This stream · #design" })
      const workspace = screen.getByRole("region", { name: "Workspace" })
      const you = screen.getByRole("region", { name: "You" })
      const scroller = workspace.closest<HTMLElement>(".overflow-y-auto")!
      // Workspace is too short to reach the top: You is still past it when the scroll ends.
      const rect = HTMLElement.prototype.getBoundingClientRect
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this === you) return new DOMRect(0, -100, 300, 400)
        if (this === workspace) return new DOMRect(0, 300, 300, 300)
        if (this === scroller) return new DOMRect(0, 0, 300, 600)
        return rect.call(this)
      })
      fireEvent.scroll(scroller)
      expect(within(scopes).getByRole("button", { name: "You" })).toHaveAttribute("aria-current", "location")

      Object.defineProperties(scroller, {
        scrollTop: { value: 1400, configurable: true },
        clientHeight: { value: 600, configurable: true },
        scrollHeight: { value: 2000, configurable: true },
      })
      fireEvent.scroll(scroller)

      expect(within(scopes).getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-current", "location")
      expect(within(scopes).getByRole("button", { name: "You" })).not.toHaveAttribute("aria-current")
    })

    it("jumps from the section menu to a section's first row, else its heading; a dismissed menu gives focus back", async () => {
      tallPages()
      linkPreviewSection = true
      const user = userEvent.setup()
      renderWindow("?settings=messages")

      const trigger = within(await screen.findByRole("navigation", { name: "On this page" })).getByRole("button")
      const openMenu = async () => {
        act(() => trigger.focus())
        await user.keyboard("{Enter}")
      }
      await openMenu()
      await user.keyboard("{Escape}")
      await waitFor(() => expect(trigger).toHaveFocus())

      await openMenu()
      fireEvent.click(await screen.findByRole("menuitem", { name: "Link previews" }))
      await waitFor(() => expect(screen.getByText("Preview count row")).toHaveFocus())

      await openMenu()
      fireEvent.click(await screen.findByRole("menuitem", { name: "Opening streams" }))
      await waitFor(() => expect(screen.getByRole("heading", { name: "Opening streams" })).toHaveFocus())
    })

    it("returns focus to the search button when Escape dismisses a page's search", async () => {
      const user = userEvent.setup()
      renderWindow("?settings=appearance")

      await screen.findByText("Appearance page")
      fireEvent.click(screen.getByRole("button", { name: "Search settings" }))
      expect(screen.getByRole("combobox", { name: "Search settings" })).toHaveFocus()
      await user.keyboard("{Escape}")

      expect(screen.queryByRole("combobox", { name: "Search settings" })).toBeNull()
      expect(screen.getByRole("button", { name: "Search settings" })).toHaveFocus()
      expect(screen.getByRole("dialog")).toBeInTheDocument()
    })

    it("closes a drilled page without leaving the index behind", async () => {
      renderWindow("?settings=")

      const index = await screen.findByRole("region", { name: "You" })
      fireEvent.click(within(index).getByRole("link", { name: /^Appearance/ }))
      await screen.findByText("Appearance page")
      fireEvent.click(screen.getByRole("button", { name: "Close settings" }))

      await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("settings="))
    })

    it("should leave nothing for Back to reopen after a drilled page follows a setting link and closes", async () => {
      settingLinkOnPage = true
      renderWindow("")

      fireEvent.click(screen.getByRole("link", { name: "Open settings" }))
      const index = await screen.findByRole("region", { name: "You" })
      fireEvent.click(within(index).getByRole("link", { name: /^Appearance/ }))
      await screen.findByText("Appearance page")
      fireEvent.click(screen.getByRole("link", { name: "Pronouns" }))
      await screen.findByText("Profile page")
      fireEvent.click(screen.getByRole("button", { name: "Close settings" }))
      await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(""))

      act(() => goBack())
      await act(async () => {})
      expect(screen.getByTestId("location").textContent).toBe("")
    })

    it("searches from any page", async () => {
      const user = userEvent.setup()
      renderWindow("?settings=appearance")

      await screen.findByText("Appearance page")
      fireEvent.click(screen.getByRole("button", { name: "Search settings" }))
      const search = screen.getByRole("combobox", { name: "Search settings" })
      expect(search).toHaveFocus()
      await user.type(search, "pronouns", { skipClick: true })
      await user.keyboard("{Enter}")

      expect(screen.getByTestId("location")).toHaveTextContent("?settings=profile&setting=pronouns")
    })
  })
})
