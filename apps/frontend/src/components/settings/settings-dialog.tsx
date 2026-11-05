import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ChevronDown, LayoutGrid, RotateCcw, Search } from "lucide-react"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
} from "@/components/ui/responsive-dialog"
import { useResponsiveMode } from "@/components/ui/responsive-mode"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { usePreferencesOptional, useSettings } from "@/contexts"
import { SETTINGS_ENTRY_ATTRIBUTE, type SettingsScope, type StreamSettingsTab } from "@/contexts/settings-context"
import { StreamSettingsPage } from "@/components/stream-settings/stream-settings-dialog"
import {
  useWorkspaceDmPeers,
  useWorkspaceFromStore,
  useWorkspaceStreamMemberships,
  useWorkspaceStreams,
  useWorkspaceUsers,
} from "@/stores/workspace-store"
import { STREAM_ICONS, canReadThroughRoot, isUtilityStream, resolveStreamName, streamLabel } from "@/lib/streams"
import { SETTINGS_TABS, type SettingsTab } from "@threahq/types"
import {
  SEARCH_SCOPE_LABELS,
  SETTINGS,
  SETTINGS_GROUP_LABELS,
  SETTINGS_PAGE_CONFIG,
  SETTINGS_SECTIONS,
  STREAM_SETTINGS,
  STREAM_SETTINGS_PAGE_CONFIG,
  STREAM_SETTINGS_SECTIONS,
  searchSettings,
  sectionsOfTab,
  settingPageTrail,
  settingsOfSection,
  settingsSectionHeadingId,
  streamOffersSetting,
  streamSectionsOfTab,
  tabOfSetting,
  lowerFirst,
  type SettingId,
  type SettingSearchResult,
  type SettingsGroup,
  type SettingsSectionId,
  type SettingsVisibility,
  type StreamSettingId,
  type StreamSettingsSectionId,
} from "./settings-registry"
import { SETTINGS_WITH_DEFAULTS, isSettingChanged, settingReset } from "./setting-defaults"
import { SETTING_CONTROL_HEIGHT, SettingsDisclosureTrigger } from "./setting-primitives"
import { SETTING_NOTE_TEXT, SETTING_SECTION_HEADING_TEXT } from "./setting-text"
import { SettingsPage } from "./settings-pages"
import { useSettingsVisibility, type ViewerSettingsVisibility } from "./use-settings-visibility"
import { useSettingsSummaries, type SettingsSummaries } from "./use-settings-summaries"
import {
  useAnyStreamSettingsTabs,
  useCanConnectStreams,
  useRouteStreamId,
  useStreamSettingsScope,
  useStreamSettingsScopeLoading,
  type StreamSettingsScope,
} from "./use-stream-settings-scope"
import { prefersReducedMotion, useLandOnSetting } from "./use-land-on-setting"
import { scrollWithin } from "./scroll-within"
import {
  SETTINGS_WINDOW_CLASSNAMES,
  SettingsDesktopLayout,
  SettingsIndexRows,
  SettingsMobileLayout,
  SettingsNavLink,
  SettingsPageSkeleton,
  SettingsSearch,
  SettingsSearchResults,
  isSearchKey,
  useSettingsPageFocus,
  useSettingsSearch,
  useSettingsSingleColumn,
  type SettingsIndexItem,
  type SettingsPageAccess,
} from "./settings-shell"
import type { SettingsLinkHistory } from "./settings-link-history"
import { useScrollEdges } from "@/hooks/use-scroll-edges"

const GROUPS: SettingsGroup[] = ["you", "workspace"]

/** Opened in a stream, its settings come first everywhere; with none, any stream's come last. */
function scopeOrder(stream: StreamSettingsScope | null): SettingsScope[] {
  return stream ? ["stream", ...GROUPS] : [...GROUPS, "stream"]
}
/**
 * A jump list earns its place on a page of several sections that runs past the
 * window. With two, its first jump repeats the heading right under it and the
 * other is one scroll away.
 */
const MIN_JUMP_SECTIONS = 3

/** How a page's nav and overview rows mark who may change it. */
function pageAccess(tab: SettingsTab, visibility: ViewerSettingsVisibility): SettingsPageAccess | undefined {
  if (SETTINGS_PAGE_CONFIG[tab].admins) return "admins"
  return visibility.viewOnly.has(tab) ? "view-only" : undefined
}

interface JumpSection {
  id: SettingsSectionId | StreamSettingsSectionId
  title: string
}

/** A page's sections, less those whose every setting is hidden; a section of rows outside the registry, such as shortcuts, stays. */
function pageSections(tab: SettingsTab, visibility: SettingsVisibility): JumpSection[] {
  return sectionsOfTab(tab)
    .filter((section) => {
      const settings = settingsOfSection(section)
      return settings.length === 0 || settings.some((id) => !visibility.hidden.has(id))
    })
    .map((section) => ({ id: section, title: SETTINGS_SECTIONS[section].title }))
}

function streamPageSections(tab: StreamSettingsTab, stream: StreamSettingsScope): JumpSection[] {
  return streamSectionsOfTab(tab, stream.type).map((section) => ({
    id: section,
    title: STREAM_SETTINGS_SECTIONS[section].title,
  }))
}

/** The overview's group of stream pages with no stream in view: each asks which stream. */
const ANY_STREAM_GROUP_LABEL = "Stream settings"

/**
 * Focus after the window closes (Escape, its close button, Back): the control
 * that opened it, or, when that is gone or the window opened from a link, the
 * sidebar's settings link.
 */
function restoreFocus(opener: HTMLElement | null) {
  opener?.focus()
  if (opener?.isConnected && document.activeElement === opener) return
  document.querySelector<HTMLElement>(`[${SETTINGS_ENTRY_ATTRIBUTE}]`)?.focus()
}

export function SettingsDialog() {
  const { isOpen, closeSettings } = useSettings()
  const { workspaceId = "" } = useParams<{ workspaceId: string }>()
  const [mounted, setMounted] = useState(false)
  const [isShortcutCaptureActive, setIsShortcutCaptureActive] = useState(false)
  // Escape reaches the dialog before the search field: a query clears first.
  const clearQueryRef = useRef<(() => boolean) | null>(null)
  // A created invite link exists only in its create response, and the Connect
  // page unmounts on a page switch, so the links live here until the window closes.
  const [inviteLinks, setInviteLinks] = useState<ReadonlyMap<string, string>>(() => new Map())
  useEffect(() => {
    if (!isOpen) setInviteLinks(new Map())
  }, [isOpen])

  // Delay dialog render until after hydration to avoid scroll lock measurement issues
  useEffect(() => {
    setMounted(true)
  }, [])

  // Read before the window takes focus: layout effects run ahead of its own.
  const openerRef = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!isOpen) return
    const active = document.activeElement
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
  }, [isOpen])

  if (!mounted) return null

  return (
    <ResponsiveDialog
      open={isOpen}
      onOpenChange={(open) => !open && closeSettings()}
      historyEntry={false}
      disableSnapPoints
    >
      <ResponsiveDialogContent
        desktopClassName={SETTINGS_WINDOW_CLASSNAMES.desktop}
        drawerClassName={SETTINGS_WINDOW_CLASSNAMES.drawer}
        hideCloseButton
        onEscapeKeyDown={(event) => {
          if (isShortcutCaptureActive || clearQueryRef.current?.()) event.preventDefault()
        }}
        // Focus is placed by the window itself: search, the heading, or the setting a link named.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus(openerRef.current)
        }}
      >
        {isOpen && (
          <SettingsWindow
            workspaceId={workspaceId}
            capturingShortcut={isShortcutCaptureActive}
            onShortcutCaptureChange={setIsShortcutCaptureActive}
            clearQueryRef={clearQueryRef}
            inviteLinks={inviteLinks}
            onInviteLinkCreated={(connectionId, url) =>
              setInviteLinks((links) => new Map(links).set(connectionId, url))
            }
          />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

interface SettingsWindowProps {
  workspaceId: string
  capturingShortcut: boolean
  onShortcutCaptureChange: (capturing: boolean) => void
  clearQueryRef: React.MutableRefObject<(() => boolean) | null>
  inviteLinks: ReadonlyMap<string, string>
  onInviteLinkCreated: (connectionId: string, url: string) => void
}

function SettingsWindow({
  workspaceId,
  capturingShortcut,
  onShortcutCaptureChange,
  clearQueryRef,
  inviteLinks,
  onInviteLinkCreated,
}: SettingsWindowProps) {
  const {
    activeTab,
    activeStreamTab,
    streamIndex,
    streamId,
    activeSetting,
    closeSettings,
    getSettingsUrl,
    getStreamSettingsUrl,
    linkHistory,
    back,
  } = useSettings()
  const isMobile = useResponsiveMode()
  const singleColumn = useSettingsSingleColumn()
  const visibility = useSettingsVisibility(workspaceId)
  const workspace = useWorkspaceFromStore(workspaceId)
  const routeStreamId = useRouteStreamId()
  const scopeStreamId = streamId ?? routeStreamId
  const stream = useStreamSettingsScope(workspaceId, scopeStreamId)
  const streamLoading = useStreamSettingsScopeLoading(workspaceId, scopeStreamId)
  const anyStreamTabs = useAnyStreamSettingsTabs(workspaceId)
  const summaries = useSettingsSummaries(workspaceId, stream, { overview: true })
  const shortcutBindings = usePreferencesOptional()?.preferences?.keyboardShortcuts
  const [content, setContent] = useState<HTMLDivElement | null>(null)

  // A page this viewer can't see (an admin page, before or without admin
  // rights) waits for permissions, then falls back to the overview; a
  // workspace page waits too, rather than showing controls it may lock.
  const pendingPermissions =
    activeTab !== null &&
    !visibility.permissionsLoaded &&
    (!visibility.tabs.includes(activeTab) || SETTINGS_PAGE_CONFIG[activeTab].group === "workspace")
  const tab = activeTab && visibility.tabs.includes(activeTab) ? activeTab : null
  // A stream page waits while its stream may still load; two columns show the
  // first page for the stream's bare `?stream-settings=`, one column the index
  // at the stream.
  let streamTab: StreamSettingsTab | null = activeStreamTab
  if (stream && (activeStreamTab || (streamIndex && !singleColumn))) {
    streamTab = activeStreamTab && stream.tabs.includes(activeStreamTab) ? activeStreamTab : stream.tabs[0]
  }
  // A stream page with no stream to show, none in view or one gone, asks which stream.
  const picking = !stream && !streamLoading ? activeStreamTab : null
  const streamPending = !stream && streamLoading && (activeStreamTab !== null || (streamIndex && !singleColumn))
  const onPage = tab !== null || streamTab !== null || picking !== null
  const overviewPending = !onPage && !pendingPermissions && !visibility.permissionsLoaded
  let pageKey: string | null = tab
  if (picking) pageKey = `stream-picker:${picking}`
  else if (streamTab) pageKey = `stream:${streamTab}`

  const { searchRef, headingRef, searchTriggerRef, pageSearchOpen, setPageSearchOpen, dismissPageSearch } =
    useSettingsPageFocus(pageKey, activeSetting, isMobile, content)
  // One column shows the search field on the index, and on a page once asked for.
  const searchShown = !singleColumn || !onPage || pageSearchOpen

  const resultHref = (result: SettingSearchResult): string =>
    result.target.kind === "settings"
      ? getSettingsUrl(result.target.tab, result.target.anchor)
      : getStreamSettingsUrl(
          result.needsStream ? null : (stream?.streamId ?? null),
          result.target.tab,
          result.target.anchor
        )

  const navigate = useNavigate()
  const search = useCallback(
    (query: string) =>
      searchSettings(query, visibility, { shortcutBindings, stream: stream ?? undefined, anyStreamTabs }),
    [visibility, shortcutBindings, stream, anyStreamTabs]
  )
  const settingsSearch = useSettingsSearch(search, (result) => {
    clearSearch()
    navigate(resultHref(result), linkHistory)
  })
  const { query, searching, changeQuery } = settingsSearch
  const clearSearch = () => {
    changeQuery("")
    setPageSearchOpen(false)
  }

  useLandOnSetting(
    content,
    streamPending || pendingPermissions || picking ? null : pageKey,
    searching ? null : activeSetting
  )
  useSearchScroll(content, searching)
  const pageOverflows = useOverflows(content)

  useEffect(() => {
    clearQueryRef.current = () => {
      if (!query && !pageSearchOpen) return false
      changeQuery("")
      dismissPageSearch()
      return true
    }
    return () => {
      clearQueryRef.current = null
    }
  })

  const onWindowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!isSearchKey(event, capturingShortcut, shortcutBindings)) return
    event.preventDefault()
    // The same chord searches the stream behind the window; this press is the window's.
    event.stopPropagation()
    if (searchShown) {
      searchRef.current?.focus()
      searchRef.current?.select()
    } else setPageSearchOpen(true)
  }

  const searchField = searchShown && (
    <SettingsSearch
      inputRef={searchRef}
      query={query}
      hasResults={searching && settingsSearch.results.length > 0}
      activeId={settingsSearch.activeId}
      onQueryChange={changeQuery}
      onKeyDown={settingsSearch.onKeyDown}
    />
  )

  const focusHeading = () => headingRef.current?.focus()
  const indexProps: IndexProps = {
    visibility,
    summaries,
    workspaceName: workspace?.name,
    stream,
    anyStreamTabs,
    scope: streamIndex ? "stream" : null,
    getSettingsUrl,
    getStreamSettingsUrl,
    linkHistory,
    onChangedEmptied: focusHeading,
    container: content,
  }

  let body: ReactNode
  if (pendingPermissions || streamPending || overviewPending) {
    body = <SettingsPageSkeleton />
  } else if (picking) {
    body = (
      <StreamSettingsPicker
        workspaceId={workspaceId}
        tab={picking}
        setting={activeSetting}
        getStreamSettingsUrl={getStreamSettingsUrl}
        linkHistory={linkHistory}
      />
    )
  } else if (tab) {
    body = <SettingsPage tab={tab} workspaceId={workspaceId} onShortcutCaptureChange={onShortcutCaptureChange} />
  } else if (streamTab && stream) {
    body = (
      <StreamSettingsPage
        workspaceId={workspaceId}
        streamId={stream.streamId}
        tab={streamTab}
        inviteLinks={inviteLinks}
        onInviteLinkCreated={onInviteLinkCreated}
      />
    )
  } else {
    body = <Overview {...indexProps} singleColumn={singleColumn} />
  }
  // Results cover the page rather than replace it, so a draft on it survives a search.
  body = (
    <>
      {searching && (
        <SettingsSearchResults
          query={query}
          results={settingsSearch.results}
          activeId={settingsSearch.activeId}
          hrefOf={resultHref}
          history={linkHistory}
          valueOf={(result) => summaries.values[result.id as keyof SettingsSummaries["values"]]}
          onPicked={clearSearch}
          onKeyDown={settingsSearch.onKeyDown}
        />
      )}
      <div hidden={searching} inert={searching}>
        {body}
      </div>
    </>
  )

  let jumpSections: JumpSection[] = []
  if (tab && !pendingPermissions) jumpSections = pageSections(tab, visibility)
  else if (streamTab && stream) jumpSections = streamPageSections(streamTab, stream)
  let jumpList: ReactNode = null
  if (!searching && jumpSections.length >= MIN_JUMP_SECTIONS && pageOverflows) {
    jumpList = <SectionJumpList key={pageKey} sections={jumpSections} container={content} menu={singleColumn} />
  } else if (!searching && singleColumn && !onPage && !overviewPending) {
    jumpList = <ScopeJumps stream={stream} container={content} landing={indexProps.scope} />
  }
  const description = (
    <ResponsiveDialogDescription className="sr-only">
      Search and change your settings, this workspace&apos;s and this stream&apos;s.
    </ResponsiveDialogDescription>
  )

  let eyebrow: string | null = null
  let pageTitle: string | null = null
  if (tab) {
    eyebrow = SETTINGS_GROUP_LABELS[SETTINGS_PAGE_CONFIG[tab].group]
    pageTitle = SETTINGS_PAGE_CONFIG[tab].label
  } else if (picking) {
    const named =
      activeSetting && Object.hasOwn(STREAM_SETTINGS, activeSetting)
        ? STREAM_SETTINGS[activeSetting as StreamSettingId].label
        : STREAM_SETTINGS_PAGE_CONFIG[picking].label
    eyebrow = `${ANY_STREAM_GROUP_LABEL} · ${named}`
    pageTitle = "Choose a stream"
  } else if (streamTab) {
    eyebrow = stream ? `${SEARCH_SCOPE_LABELS.stream} · ${stream.name}` : SEARCH_SCOPE_LABELS.stream
    pageTitle = STREAM_SETTINGS_PAGE_CONFIG[streamTab].label
  }

  if (singleColumn) {
    return (
      <SettingsMobileLayout
        back={
          onPage
            ? {
                href: getSettingsUrl(),
                label: "Back",
                onClick: (event: MouseEvent) => {
                  event.preventDefault()
                  back(getSettingsUrl())
                },
              }
            : null
        }
        eyebrow={eyebrow}
        title={pageTitle ?? "Settings"}
        titleRef={headingRef}
        description={description}
        actions={
          onPage &&
          !pageSearchOpen && (
            <Button
              ref={searchTriggerRef}
              variant="ghost"
              size="icon"
              className="h-11 w-11 shrink-0"
              aria-label="Search settings"
              onClick={() => setPageSearchOpen(true)}
            >
              <Search className="h-5 w-5" />
            </Button>
          )
        }
        onClose={closeSettings}
        subheader={jumpList}
        search={searchField}
        contentRef={setContent}
        onKeyDown={onWindowKeyDown}
      >
        {body}
      </SettingsMobileLayout>
    )
  }

  let heading: string | null = pageTitle ?? (overviewPending || streamPending ? null : "Overview")
  if (searching) {
    eyebrow = "Search"
    heading = `Results for “${query.trim()}”`
  }

  return (
    <SettingsDesktopLayout
      description={description}
      search={searchField}
      nav={
        <DesktopNav
          tab={searching ? undefined : tab}
          streamTab={searching ? undefined : streamTab}
          visibility={visibility}
          workspaceName={workspace?.name}
          stream={stream}
          getSettingsUrl={getSettingsUrl}
          getStreamSettingsUrl={getStreamSettingsUrl}
          onNavigate={clearSearch}
        />
      }
      eyebrow={eyebrow}
      heading={heading}
      headingRef={headingRef}
      headerExtra={jumpList}
      onClose={closeSettings}
      contentRef={setContent}
      onKeyDown={onWindowKeyDown}
    >
      {body}
    </SettingsDesktopLayout>
  )
}

/** Results open at their top; clearing the query returns the page to where it was being read. */
function useSearchScroll(content: HTMLElement | null, searching: boolean) {
  const wasSearching = useRef(searching)
  const pageScrollTop = useRef(0)
  useLayoutEffect(() => {
    if (!content || wasSearching.current === searching) return
    wasSearching.current = searching
    if (searching) {
      pageScrollTop.current = content.scrollTop
      content.scrollTop = 0
    } else {
      content.scrollTop = pageScrollTop.current
    }
  }, [content, searching])
}

/** Whether `container`'s content runs past it. */
function useOverflows(container: HTMLElement | null): boolean {
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    if (!container) return
    const measure = () => setOverflows(container.scrollHeight > container.clientHeight + 1)
    measure()
    let frame = 0
    const later = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    const resize = new ResizeObserver(later)
    resize.observe(container)
    // Pages mount their sections as their data arrives.
    const mutation = new MutationObserver(later)
    mutation.observe(container, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      mutation.disconnect()
    }
  }, [container])
  return overflows
}

/** How far below the content's top a part counts as the one being read. */
const SPY_OFFSET_PX = 32

function sectionElement(container: HTMLElement, id: JumpSection["id"]): HTMLElement | null {
  return (
    container.querySelector<HTMLElement>(`#${CSS.escape(settingsSectionHeadingId(id))}`)?.closest("section") ?? null
  )
}

/** `ids` in the order their parts render, those not rendered yet last. */
function renderedOrder<Id extends string>(
  container: HTMLElement,
  ids: readonly Id[],
  partOf: (container: HTMLElement, id: Id) => HTMLElement | null
): Id[] {
  const parts = ids.map((id) => ({ id, element: partOf(container, id) }))
  const rendered = parts.filter((part): part is { id: Id; element: HTMLElement } => part.element !== null)
  rendered.sort((a, b) => (a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
  return [...rendered.map((part) => part.id), ...parts.filter((part) => !part.element).map((part) => part.id)]
}

/** What a reader does to scroll by hand, which lets go of a jump. */
const READER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const

/**
 * Jumps down one scroll to its parts, focusing what `focusIn` picks in the
 * part, and tracks the part being read: the last whose top has passed the
 * content's top, the one holding a focused row in view, or the last once the
 * scroll ends. A jump, or landing on `landing`, holds its part at the top and
 * current until the reader scrolls by hand, so content arriving above it, or
 * a part too near the end to reach the top, can't take that away. Parts are
 * listed in the order the page renders them, whatever order `ids` gives.
 * `partOf` and `focusIn` must be stable between renders.
 */
function useJumpSpy<Id extends string>(
  container: HTMLElement | null,
  ids: readonly Id[],
  partOf: (container: HTMLElement, id: Id) => HTMLElement | null,
  focusIn: (part: HTMLElement) => HTMLElement | null,
  landing: Id | null = null
) {
  const key = ids.join(" ")
  const [active, setActive] = useState<Id | undefined>(ids[0])
  const [orderKey, setOrderKey] = useState(key)
  const held = useRef<Id | null>(null)

  useEffect(() => {
    if (!container) return
    const partIds = key.split(" ") as Id[]
    // A row a link landed on, or one being tabbed through, is centred rather
    // than at the top: while it shows, its part is the one being read.
    const focusedPart = (bounds: DOMRect): Id | undefined => {
      const focused = document.activeElement
      if (!(focused instanceof HTMLElement) || !container.contains(focused)) return undefined
      const rect = focused.getBoundingClientRect()
      if (rect.bottom < bounds.top || rect.top > bounds.bottom) return undefined
      return partIds.find((id) => partOf(container, id)?.contains(focused))
    }
    const spy = () => {
      const ordered = renderedOrder(container, partIds, partOf)
      setOrderKey(ordered.join(" "))
      if (held.current) {
        setActive(held.current)
        return
      }
      const bounds = container.getBoundingClientRect()
      let current = ordered[0]
      for (const id of ordered) {
        const element = partOf(container, id)
        if (element && element.getBoundingClientRect().top - bounds.top <= SPY_OFFSET_PX) current = id
      }
      const atEnd =
        container.scrollTop > 0 && container.scrollTop + container.clientHeight >= container.scrollHeight - 2
      setActive(focusedPart(bounds) ?? (atEnd ? ordered[ordered.length - 1] : current))
    }
    const keepHeld = () => {
      const part = held.current && partOf(container, held.current)
      if (part) scrollWithin(container, part, "start")
    }
    const letGo = () => {
      held.current = null
    }
    let frame = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        keepHeld()
        spy()
      })
    })
    observer.observe(container, { childList: true, subtree: true })
    spy()
    container.addEventListener("scroll", spy, { passive: true })
    container.addEventListener("focusin", spy)
    for (const type of READER_SCROLL_EVENTS) container.addEventListener(type, letGo, { passive: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      container.removeEventListener("scroll", spy)
      container.removeEventListener("focusin", spy)
      for (const type of READER_SCROLL_EVENTS) container.removeEventListener(type, letGo)
    }
  }, [container, key, partOf])

  const hold = (id: Id, behavior: ScrollBehavior): HTMLElement | null => {
    const target = container ? partOf(container, id) : null
    if (!container || !target) return null
    held.current = id
    scrollWithin(container, target, "start", behavior)
    setActive(id)
    return target
  }

  useLayoutEffect(() => {
    if (landing) hold(landing, "auto")
    // `key` lands again once a part rendering late, such as the stream's group, reorders the parts.
  }, [container, landing, key])

  const jump = (id: Id): boolean => {
    const target = hold(id, prefersReducedMotion() ? "auto" : "smooth")
    const focus = target && focusIn(target)
    focus?.focus({ preventScroll: true })
    return !!focus && document.activeElement === focus
  }

  const order = orderKey.split(" ").sort().join(" ") === [...ids].sort().join(" ") ? (orderKey.split(" ") as Id[]) : ids
  return { active, jump, order }
}

/** A row of jump buttons, the one being read marked as the current location. */
function JumpChips<Id extends string>({
  label,
  items,
  active,
  onJump,
}: {
  label: string
  items: readonly { id: Id; title: string }[]
  active: Id | undefined
  onJump: (id: Id) => void
}) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-1">
        {items.map((item) => (
          <li key={item.id} className="min-w-0 max-w-full">
            <button
              type="button"
              aria-current={active === item.id ? "location" : undefined}
              onClick={() => onJump(item.id)}
              className="inline-flex min-h-8 max-w-full items-center rounded-md px-2 text-[0.8125rem] [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=location]:bg-muted aria-[current=location]:font-medium aria-[current=location]:text-foreground"
            >
              <span className="truncate">{item.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

/** A section's first row, else its heading. */
function sectionFocusTarget(section: HTMLElement): HTMLElement | null {
  const headingId = section.getAttribute("aria-labelledby")
  return (
    section.querySelector<HTMLElement>("[data-setting]") ??
    (headingId ? section.querySelector<HTMLElement>(`#${CSS.escape(headingId)}`) : null)
  )
}

/**
 * Jumps down a long page to one of its sections, focusing its first row and
 * marking the section being read. Desktop wraps them as chips; a phone has
 * one menu button naming the current section, so no title is cut.
 */
function SectionJumpList({
  sections,
  container,
  menu,
}: {
  sections: JumpSection[]
  container: HTMLElement | null
  menu: boolean
}) {
  const { active, jump, order } = useJumpSpy(
    container,
    sections.map((section) => section.id),
    sectionElement,
    sectionFocusTarget
  )
  const ordered = order.flatMap((id) => sections.filter((section) => section.id === id))
  // The menu traps focus until it closes, so a picked section is jumped to once it has.
  const picked = useRef<JumpSection["id"] | null>(null)

  if (menu) {
    const current = ordered.find((section) => section.id === active) ?? ordered[0]
    return (
      <nav aria-label="On this page">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-2 rounded-md text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="text-muted-foreground">On this page</span>
              <span className="min-w-0 flex-1 font-medium">{current?.title}</span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="min-w-56"
            onCloseAutoFocus={(event) => {
              const id = picked.current
              picked.current = null
              if (id && jump(id)) event.preventDefault()
            }}
          >
            {ordered.map((section) => (
              <DropdownMenuItem
                key={section.id}
                aria-current={active === section.id ? "location" : undefined}
                onSelect={() => {
                  picked.current = section.id
                }}
                className="min-h-11 aria-[current=location]:font-medium"
              >
                {section.title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    )
  }

  return <JumpChips label="On this page" items={ordered} active={active} onJump={jump} />
}

/** A scope's own name after its label, as written: an uppercase heading doesn't recase it. */
const GROUP_NAME_CLASS = "font-normal normal-case tracking-normal"

function GroupLabelText({
  group,
  workspaceName,
  stream,
}: {
  group: SettingsScope
  workspaceName: string | undefined
  stream: StreamSettingsScope | null
}) {
  if (group === "stream") {
    if (!stream) return <>{ANY_STREAM_GROUP_LABEL}</>
    return (
      <>
        {SEARCH_SCOPE_LABELS.stream} <span className={GROUP_NAME_CLASS}>· {stream.name}</span>
      </>
    )
  }
  return (
    <>
      {SETTINGS_GROUP_LABELS[group]}
      {group === "workspace" && workspaceName && (
        <>
          {" "}
          <span className={GROUP_NAME_CLASS}>· {workspaceName}</span>
        </>
      )}
    </>
  )
}

interface NavItem {
  key: string
  /** Permissions still decide whether it shows. */
  pending: boolean
  href: string
  icon: SettingsIndexItem["icon"]
  label: string
  active: boolean
  access?: SettingsPageAccess
}

/** A group's pages in order, with a placeholder where permissions still decide. */
function navTabsOfGroup(visibility: ViewerSettingsVisibility, group: SettingsGroup) {
  return SETTINGS_TABS.filter(
    (tab) =>
      SETTINGS_PAGE_CONFIG[tab].group === group &&
      (visibility.tabs.includes(tab) || visibility.pendingTabs.includes(tab))
  ).map((tab) => ({ tab, pending: !visibility.tabs.includes(tab) }))
}

function DesktopNav({
  tab,
  streamTab,
  visibility,
  workspaceName,
  stream,
  getSettingsUrl,
  getStreamSettingsUrl,
  onNavigate,
}: {
  /** The page shown; undefined while results replace it, so nothing reads as current. */
  tab: SettingsTab | null | undefined
  streamTab: StreamSettingsTab | null | undefined
  visibility: ViewerSettingsVisibility
  workspaceName: string | undefined
  stream: StreamSettingsScope | null
  getSettingsUrl: (tab?: SettingsTab) => string
  getStreamSettingsUrl: (streamId: string, tab?: StreamSettingsTab) => string
  onNavigate: () => void
}) {
  const groupId = useId()
  const [nav, setNav] = useState<HTMLElement | null>(null)
  const clipped = useScrollEdges(nav).below
  const streamId = stream?.streamId
  useLayoutEffect(() => {
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]')
    if (nav && current) scrollWithin(nav, current, "nearest")
  }, [nav, tab, streamTab, streamId, visibility.permissionsLoaded])
  const itemsOf = (group: SettingsScope): NavItem[] => {
    if (group === "stream") {
      return stream
        ? stream.tabs.map((item) => ({
            key: item,
            pending: false,
            href: getStreamSettingsUrl(stream.streamId, item),
            icon: STREAM_SETTINGS_PAGE_CONFIG[item].icon,
            label: STREAM_SETTINGS_PAGE_CONFIG[item].label,
            active: streamTab === item,
          }))
        : []
    }
    return navTabsOfGroup(visibility, group).map(({ tab: item, pending }) => ({
      key: item,
      pending,
      href: getSettingsUrl(item),
      icon: SETTINGS_PAGE_CONFIG[item].icon,
      label: SETTINGS_PAGE_CONFIG[item].label,
      active: tab === item,
      access: pageAccess(item, visibility),
    }))
  }
  const groups = scopeOrder(stream)
    .map((group) => ({ group, items: itemsOf(group) }))
    .filter(({ items }) => items.length > 0)

  return (
    <nav
      ref={setNav}
      aria-label="Settings pages"
      aria-busy={visibility.permissionsLoaded ? undefined : true}
      data-clipped={clipped ? "" : undefined}
      className="min-h-0 flex-1 overflow-y-auto px-3 scrollbar-thin [scrollbar-gutter:stable] data-[clipped]:[mask-image:linear-gradient(to_bottom,#000_calc(100%_-_2rem),transparent)]"
    >
      <div className="pb-2">
        <SettingsNavLink
          href={getSettingsUrl()}
          active={tab === null && !streamTab}
          icon={<LayoutGrid className="h-4 w-4" aria-hidden />}
          label="Overview"
          onNavigate={onNavigate}
        />
        {groups.map(({ group, items }) => {
          const labelId = `${groupId}-${group}`
          return (
            <div key={group} className="mt-1.5">
              <p id={labelId} className="truncate px-2 pb-0.5 text-xs font-medium leading-4 text-muted-foreground">
                <GroupLabelText group={group} workspaceName={workspaceName} stream={stream} />
              </p>
              <ul aria-labelledby={labelId}>
                {items.map((item) => {
                  const Icon = item.icon
                  return (
                    <li key={item.key}>
                      <SettingsNavLink
                        href={item.pending ? null : item.href}
                        active={item.active}
                        icon={<Icon className="h-4 w-4" aria-hidden />}
                        label={item.label}
                        access={item.access}
                        onNavigate={onNavigate}
                      />
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </nav>
  )
}

interface IndexProps {
  visibility: ViewerSettingsVisibility
  summaries: SettingsSummaries
  workspaceName: string | undefined
  stream: StreamSettingsScope | null
  /** Without a stream: the stream pages some stream of the viewer's has, each asking which stream. */
  anyStreamTabs: readonly StreamSettingsTab[]
  /** A stream link with no page names the stream's scope: the index opens scrolled to it. */
  scope: SettingsScope | null
  getSettingsUrl: (tab?: SettingsTab, setting?: string) => string
  getStreamSettingsUrl: (streamId: string | null, tab?: StreamSettingsTab) => string
  linkHistory: SettingsLinkHistory
  /** The last changed setting was reset, so its list is gone; focus goes elsewhere. */
  onChangedEmptied: () => void
  /** The window's scroll, which the index lands in. */
  container: HTMLElement | null
}

function groupAnchor(group: SettingsScope): string {
  return `settings-overview-${group}`
}

function OverviewGroup({
  group,
  items,
  workspaceName,
  stream,
  linkHistory,
  columns,
}: {
  group: SettingsScope
  items: SettingsIndexItem[]
  workspaceName: string | undefined
  stream: StreamSettingsScope | null
  linkHistory: SettingsLinkHistory
  columns: boolean
}) {
  const headingId = groupAnchor(group)
  return (
    <section aria-labelledby={headingId} className="scroll-mt-4 space-y-2">
      <h3 id={headingId} className={cn("py-1", SETTING_SECTION_HEADING_TEXT)}>
        <GroupLabelText group={group} workspaceName={workspaceName} stream={stream} />
      </h3>
      <SettingsIndexRows items={items} history={linkHistory} columns={columns} />
    </section>
  )
}

function pageItems({ visibility, summaries, getSettingsUrl }: IndexProps, group: SettingsGroup): SettingsIndexItem[] {
  return visibility.tabs
    .filter((tab) => SETTINGS_PAGE_CONFIG[tab].group === group)
    .map((tab) => ({
      key: tab,
      href: getSettingsUrl(tab),
      icon: SETTINGS_PAGE_CONFIG[tab].icon,
      label: SETTINGS_PAGE_CONFIG[tab].label,
      value: summaries.pages[tab],
      covers: SETTINGS_PAGE_CONFIG[tab].covers,
      access: pageAccess(tab, visibility),
    }))
}

/** "Replies, what the agent sees, context": one sentence, as your pages' lists of what they cover read. */
function sectionTitles(sections: readonly StreamSettingsSectionId[]): string {
  return sections
    .map((section, index) => {
      const title = STREAM_SETTINGS_SECTIONS[section].title
      return index === 0 ? title : lowerFirst(title)
    })
    .join(", ")
}

/** The stream in view's pages, or with none, every stream page, each asking which stream. */
function streamItems({ stream, anyStreamTabs, summaries, getStreamSettingsUrl }: IndexProps): SettingsIndexItem[] {
  if (!stream) {
    const sections = Object.keys(STREAM_SETTINGS_SECTIONS) as StreamSettingsSectionId[]
    return anyStreamTabs.map((tab) => ({
      key: tab,
      href: getStreamSettingsUrl(null, tab),
      icon: STREAM_SETTINGS_PAGE_CONFIG[tab].icon,
      label: STREAM_SETTINGS_PAGE_CONFIG[tab].label,
      covers: sectionTitles(sections.filter((section) => STREAM_SETTINGS_SECTIONS[section].tab === tab)),
    }))
  }
  return stream.tabs.map((tab) => ({
    key: tab,
    href: getStreamSettingsUrl(stream.streamId, tab),
    icon: STREAM_SETTINGS_PAGE_CONFIG[tab].icon,
    label: STREAM_SETTINGS_PAGE_CONFIG[tab].label,
    value: summaries.streamPages[tab],
    covers: sectionTitles(streamSectionsOfTab(tab, stream.type)),
  }))
}

/**
 * Settings whose value differs from the default, one press from each and,
 * where nothing the user wrote would be lost, from its reset.
 */
function ChangedSettings({ visibility, summaries, getSettingsUrl, linkHistory, onChangedEmptied }: IndexProps) {
  const preferencesContext = usePreferencesOptional()
  const preferences = preferencesContext?.preferences
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const changed = SETTINGS_WITH_DEFAULTS.filter((id) => {
    const tab = tabOfSetting(id)
    return tab && visibility.tabs.includes(tab) && !visibility.hidden.has(id) && isSettingChanged(id, preferences)
  })
  if (!preferencesContext || !preferences || changed.length === 0) return null

  const reset = (id: SettingId) => {
    const input = settingReset(id, preferences)
    if (!input) return
    // The row leaves the list, so focus moves to what stays.
    if (changed.length > 1) triggerRef.current?.focus()
    else onChangedEmptied()
    void preferencesContext.updatePreferences(input).catch(() => {
      // The provider reports a failed save in a toast; the row comes back as its value rolls back.
    })
  }

  return (
    <Collapsible className="rounded-lg border bg-card">
      <SettingsDisclosureTrigger
        ref={triggerRef}
        heading="Changed from default"
        summary={changed.length === 1 ? "1 setting" : `${changed.length} settings`}
      />
      <CollapsibleContent>
        <ul id={listId} aria-label="Changed from default" className="divide-y border-t">
          {changed.map((id) => {
            const value = summaries.values[id]
            const canReset = settingReset(id, preferences) !== null
            const tab = tabOfSetting(id)
            return (
              <li key={id} className="flex items-center gap-2 pr-2">
                <Link
                  to={tab ? getSettingsUrl(tab, id) : getSettingsUrl()}
                  state={linkHistory.state}
                  className="min-w-0 flex-1 px-4 py-2.5 outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="block text-sm font-medium">{SETTINGS[id].label}</span>
                  <span className={cn("mt-0.5 block text-muted-foreground", SETTING_NOTE_TEXT)}>
                    {[value, settingPageTrail(id)].filter(Boolean).join(" · ")}
                  </span>
                </Link>
                {canReset && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn("shrink-0 px-3 text-muted-foreground", SETTING_CONTROL_HEIGHT)}
                    aria-label={`Reset ${SETTINGS[id].label}`}
                    onClick={() => reset(id)}
                  >
                    <RotateCcw aria-hidden />
                    Reset
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Opens the overview scrolled to the scope a link named, its section's margin
 * clear of the content's top; the stream's group renders once its stream loads.
 * In one column `ScopeJumps` lands instead, so `container` is null there.
 */
function useScrollToScope(
  container: HTMLElement | null,
  scope: SettingsScope | null,
  stream: StreamSettingsScope | null
) {
  const streamId = stream?.streamId
  useEffect(() => {
    const section = container && scope ? scopeElement(container, scope) : null
    if (container && section) scrollWithin(container, section, "start")
  }, [container, scope, streamId])
}

/**
 * Every scope's pages down one scroll, in `scopeOrder`. Beside the nav each
 * scope's rows run two across, so no scope's column runs long beside a short one.
 */
function Overview({ singleColumn, ...props }: IndexProps & { singleColumn: boolean }) {
  const { stream, workspaceName, linkHistory, scope, container } = props
  useScrollToScope(singleColumn ? null : container, scope, stream)
  const items: Record<SettingsScope, SettingsIndexItem[]> = {
    you: pageItems(props, "you"),
    workspace: pageItems(props, "workspace"),
    stream: streamItems(props),
  }
  return (
    <div className="space-y-6">
      <ChangedSettings {...props} />
      {scopeOrder(stream).map((group) => (
        <OverviewGroup
          key={group}
          group={group}
          items={items[group]}
          workspaceName={workspaceName}
          stream={stream}
          linkHistory={linkHistory}
          columns={!singleColumn}
        />
      ))}
    </div>
  )
}

function firstLink(part: HTMLElement): HTMLElement | null {
  return part.querySelector<HTMLElement>("a")
}

function scopeElement(container: HTMLElement, scope: SettingsScope): HTMLElement | null {
  return container.querySelector<HTMLElement>(`#${groupAnchor(scope)}`)?.closest("section") ?? null
}

/**
 * A one-column index's jumps down its single scroll, one per scope, marking
 * the scope in view. Short enough for one line: the stream's name is on its
 * group's heading.
 */
function ScopeJumps({
  stream,
  container,
  landing,
}: {
  stream: StreamSettingsScope | null
  container: HTMLElement | null
  /** The scope a link named, which the index opens at. */
  landing: SettingsScope | null
}) {
  const { active, jump, order } = useJumpSpy(container, scopeOrder(stream), scopeElement, firstLink, landing)
  const items = order.map((scope) => ({
    id: scope,
    title: scope === "stream" && !stream ? ANY_STREAM_GROUP_LABEL : SEARCH_SCOPE_LABELS[scope],
  }))
  return <JumpChips label="Settings scope" items={items} active={active} onJump={jump} />
}

/**
 * Which stream a setting found with no stream in view opens on: the viewer's
 * streams that have its page and the setting.
 */
function StreamSettingsPicker({
  workspaceId,
  tab,
  setting,
  getStreamSettingsUrl,
  linkHistory,
}: {
  workspaceId: string
  tab: StreamSettingsTab
  setting: string | null
  getStreamSettingsUrl: (streamId: string, tab?: StreamSettingsTab, setting?: string) => string
  linkHistory: SettingsLinkHistory
}) {
  const streams = useWorkspaceStreams(workspaceId)
  const memberships = useWorkspaceStreamMemberships(workspaceId)
  const users = useWorkspaceUsers(workspaceId)
  const dmPeers = useWorkspaceDmPeers(workspaceId)
  const canConnect = useCanConnectStreams(workspaceId)
  const [filter, setFilter] = useState("")
  const memberOf = new Set(memberships.map((membership) => membership.streamId))
  const byId = new Map(streams.map((stream) => [stream.id, stream]))
  const nameOf = (stream: (typeof streams)[number]) =>
    resolveStreamName(stream.id, { streams, users, dmPeers }) ?? streamLabel(stream)
  const ancestry = (stream: (typeof streams)[number]): string => {
    const parent = stream.parentStreamId ? byId.get(stream.parentStreamId) : undefined
    return parent ? `${ancestry(parent)} › ${nameOf(stream)}` : nameOf(stream)
  }
  const options = streams
    .filter(
      (stream) =>
        canReadThroughRoot(stream, byId, memberOf) &&
        !stream.archivedAt &&
        !isUtilityStream(stream) &&
        streamOffersSetting(stream, tab, setting, canConnect)
    )
    .map((stream) => ({ stream, label: ancestry(stream) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const needle = filter.trim().toLocaleLowerCase()
  const shown = needle ? options.filter(({ label }) => label.toLocaleLowerCase().includes(needle)) : options
  const items: SettingsIndexItem[] = shown.map(({ stream, label }) => ({
    key: stream.id,
    href: getStreamSettingsUrl(stream.id, tab, setting ?? undefined),
    icon: STREAM_ICONS[stream.type] as SettingsIndexItem["icon"],
    label,
  }))

  return (
    <div className="space-y-3">
      <Input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filter streams"
        aria-label="Filter streams"
        className={SETTING_CONTROL_HEIGHT}
        autoComplete="off"
      />
      {items.length > 0 ? (
        <SettingsIndexRows items={items} history={linkHistory} />
      ) : (
        <p
          className={cn(
            "rounded-lg border border-dashed px-4 py-6 text-center text-muted-foreground",
            SETTING_NOTE_TEXT
          )}
        >
          {options.length === 0 ? "None of your streams has this setting." : `No streams match “${filter.trim()}”.`}
        </p>
      )}
    </div>
  )
}
