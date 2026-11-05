import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, ChevronRight, Hash, Search, X } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { ResponsiveDialogTitle } from "@/components/ui/responsive-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { getEffectiveKeyBinding, matchesKeyBinding } from "@/lib/keyboard-shortcuts"
import { useIsMobile } from "@/hooks/use-mobile"
import { SETTINGS_PAGE_CONFIG, settingResultTrail, type SettingSearchResult } from "./settings-registry"
import { SETTING_GROUP_BAND_CLASS, SettingBadge, SettingScopeBadges } from "./setting-primitives"
import { SETTING_LEGIBLE_MUTED, SETTING_NOTE_TEXT } from "./setting-text"
import { useInWindowLinkHistory, type SettingsLinkHistory } from "./settings-link-history"

/**
 * The settings window's frame: sizes, nav rows, header, search and the phone
 * drill-down, for your pages, the workspace's and a stream's alike.
 */

export const SETTINGS_WINDOW_CLASSNAMES = {
  desktop: `w-[min(96vw,1060px)] max-w-none h-[min(800px,calc(100vh-1rem))] sm:flex flex-col overflow-hidden p-0 gap-0 ${SETTING_LEGIBLE_MUTED}`,
  drawer: `flex h-[94dvh] flex-col gap-0 ${SETTING_LEGIBLE_MUTED}`,
} as const

const RESULTS_ID = "settings-search-results"

/**
 * Below this width the window is one column, as on a phone: beside the 260px
 * nav, a row needs 64px of page padding, 32px of card padding, a 288px control,
 * a 16px gap and ~200px of label, 860px of a 96vw window.
 */
const SINGLE_COLUMN_QUERY = "(max-width: 899px)"

function subscribeSingleColumn(onChange: () => void) {
  const query = window.matchMedia(SINGLE_COLUMN_QUERY)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

/** Whether the window shows one column (index, then page) rather than nav beside page. */
export function useSettingsSingleColumn(): boolean {
  const narrow = useSyncExternalStore(subscribeSingleColumn, () => window.matchMedia(SINGLE_COLUMN_QUERY).matches)
  return useIsMobile() || narrow
}

function SettingsCloseButton({ onClose }: { onClose: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-11 w-11 shrink-0 sm:h-9 sm:w-9 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
      onClick={onClose}
      aria-label="Close settings"
    >
      <X className="h-5 w-5 sm:h-4 sm:w-4" />
    </Button>
  )
}

/** Who may change a page, where that is not everyone who sees it. */
export type SettingsPageAccess = "admins" | "view-only"

const PAGE_ACCESS_TEXT: Record<SettingsPageAccess, { shown: string; hidden: string }> = {
  admins: { shown: "Admins", hidden: " only" },
  "view-only": { shown: "View only", hidden: "" },
}

/**
 * Marks a page only workspace admins get, or one the viewer can't change. Kept
 * out of its link's name: the link points `aria-describedby` at `id`.
 */
function PageAccessChip({ access, id }: { access: SettingsPageAccess; id?: string }) {
  const { shown, hidden } = PAGE_ACCESS_TEXT[access]
  return (
    <SettingBadge id={id} aria-hidden>
      {shown}
      {hidden && <span className="sr-only">{hidden}</span>}
    </SettingBadge>
  )
}

const NAV_ROW_CLASSNAME =
  "flex min-h-7 items-center gap-2.5 rounded-md px-2 text-sm outline-none transition-colors scroll-my-8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"

/**
 * A page in the nav. `href` is `null` while permissions decide whether it
 * shows: drawn as the row it becomes, so nothing moves when it does, but inert
 * and hidden from assistive tech, which the nav's `aria-busy` tells why.
 */
export function SettingsNavLink({
  href,
  active,
  icon,
  label,
  access,
  onNavigate,
}: {
  href: string | null
  active: boolean
  icon: ReactNode
  label: string
  access?: SettingsPageAccess
  onNavigate?: () => void
}) {
  const accessId = useId()
  const history = useInWindowLinkHistory()
  const content = (
    <>
      <span className={cn(active ? "text-accent-foreground" : "text-muted-foreground")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {access && <PageAccessChip access={access} id={accessId} />}
    </>
  )
  if (href === null) {
    return (
      <div aria-hidden className={cn(NAV_ROW_CLASSNAME, "text-foreground/80")}>
        {content}
      </div>
    )
  }
  return (
    <Link
      to={href}
      replace={history.replace}
      state={history.state}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      aria-describedby={access ? accessId : undefined}
      className={cn(
        NAV_ROW_CLASSNAME,
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-foreground/80 hover:bg-muted hover:text-foreground"
      )}
    >
      {content}
    </Link>
  )
}

export interface SettingsIndexItem {
  key: string
  href: string
  icon: LucideIcon
  label: string
  /** Key current values: "Dark · Compact". */
  value?: string
  /** What the page holds: "Theme, text size, motion". */
  covers?: string
  access?: SettingsPageAccess
}

/**
 * A card of page links: the overview, a phone's index, the stream picker. The
 * page, then its current value and what it covers, each wrapping to two lines
 * at most. `columns` lays the rows out two across on wide screens, the last of
 * an odd count spanning both.
 */
export function SettingsIndexRows({
  items,
  history,
  columns = false,
}: {
  items: readonly SettingsIndexItem[]
  history: SettingsLinkHistory
  columns?: boolean
}) {
  return (
    <ul className={cn("rounded-lg border bg-card", columns ? "grid lg:grid-cols-2" : "divide-y")}>
      {items.map((item) => (
        <li
          key={item.key}
          className={cn(
            columns &&
              "border-b last:border-b-0 lg:odd:border-r lg:last:odd:col-span-2 lg:last:odd:border-r-0 lg:[&:nth-last-child(2):nth-child(odd)]:border-b-0"
          )}
        >
          <SettingsIndexRow item={item} history={history} />
        </li>
      ))}
    </ul>
  )
}

function SettingsIndexRow({ item, history }: { item: SettingsIndexItem; history: SettingsLinkHistory }) {
  const { href, icon: Icon, label, value, covers, access } = item
  const accessId = useId()
  return (
    <Link
      to={href}
      replace={history.replace}
      state={history.state}
      aria-describedby={access ? accessId : undefined}
      className="flex h-full min-h-12 items-start gap-3 px-4 py-2.5 outline-none hover:bg-muted/60 active:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:min-h-10 sm:px-3 sm:py-2"
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground sm:h-4 sm:w-4" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[0.9375rem] font-medium sm:text-sm">{label}</span>
          {access && <PageAccessChip access={access} id={accessId} />}
        </span>
        {value && <span className={cn("mt-0.5 line-clamp-2 text-foreground", SETTING_NOTE_TEXT)}>{value}</span>}
        {covers && <span className={cn("mt-0.5 line-clamp-2 text-muted-foreground", SETTING_NOTE_TEXT)}>{covers}</span>}
      </span>
      <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </Link>
  )
}

export function SettingsPageSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-24 w-full rounded-lg" />
      <Skeleton className="h-24 w-full rounded-lg" />
    </div>
  )
}

function optionId(result: SettingSearchResult): string {
  return `settings-result-${result.target.kind}-${result.id}`
}

/**
 * Query, results and the keys over them, for the search field and the results
 * list alike: arrows move the active result, Enter opens it. `search` must be
 * stable between renders.
 */
export function useSettingsSearch(
  search: (query: string) => SettingSearchResult[],
  open: (result: SettingSearchResult) => void
) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const results = useMemo(() => search(query), [search, query])
  const searching = query.trim().length > 0
  const active = searching ? results[Math.min(activeIndex, results.length - 1)] : undefined

  const changeQuery = (next: string) => {
    setQuery(next)
    setActiveIndex(0)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!searching || results.length === 0) return
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setActiveIndex((index) => (Math.min(index, results.length - 1) + step + results.length) % results.length)
    } else if (event.key === "Enter" && active) {
      event.preventDefault()
      open(active)
    }
  }
  return { query, results, searching, activeId: active ? optionId(active) : undefined, changeQuery, onKeyDown }
}

export function SettingsSearch({
  inputRef,
  query,
  hasResults,
  activeId,
  onQueryChange,
  onKeyDown,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  /** The results listbox is rendered, so the field may point at it. */
  hasResults: boolean
  activeId: string | undefined
  onQueryChange: (query: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={inputRef}
        type="search"
        role="combobox"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search settings"
        aria-label="Search settings"
        aria-expanded={hasResults}
        aria-controls={hasResults ? RESULTS_ID : undefined}
        aria-autocomplete="list"
        aria-activedescendant={hasResults ? activeId : undefined}
        className="h-11 bg-background pl-9 pr-11 sm:h-8 sm:pr-8 [&::-webkit-search-cancel-button]:appearance-none [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:pr-11"
        autoComplete="off"
        enterKeyHint="go"
      />
      {query && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onQueryChange("")
            inputRef.current?.focus()
          }}
          className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-8 sm:w-8 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  )
}

export function SettingsSearchResults({
  query,
  results,
  activeId,
  hrefOf,
  historyOf,
  valueOf,
  onPicked,
  onKeyDown,
}: {
  query: string
  results: SettingSearchResult[]
  activeId: string | undefined
  /** The search field's keys: the list is a tab stop of its own, so Tab past the field reaches the results too. */
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  hrefOf: (result: SettingSearchResult) => string
  historyOf: (result: SettingSearchResult) => SettingsLinkHistory
  /** A result's current value, where one reads in a few words. */
  valueOf: (result: SettingSearchResult) => string | undefined
  onPicked: () => void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const groupId = useId()
  useEffect(() => {
    if (!activeId) return
    listRef.current?.querySelector(`#${CSS.escape(activeId)}`)?.scrollIntoView?.({ block: "nearest" })
  }, [activeId])
  const direct = results.filter((result) => !result.related && !result.keysInUse)
  const groups = [
    { label: "Keys already in use", results: results.filter((result) => result.keysInUse) },
    { label: "Related", results: results.filter((result) => result.related) },
  ]
  const option = (result: SettingSearchResult) => (
    <SettingsSearchOption
      key={optionId(result)}
      result={result}
      active={optionId(result) === activeId}
      href={hrefOf(result)}
      history={historyOf(result)}
      value={valueOf(result)}
      onPicked={onPicked}
    />
  )
  return (
    <div>
      <p role="status" className="sr-only">
        {results.length === 0 ? "No settings found" : `${results.length} settings found`}
      </p>
      {results.length === 0 ? (
        <div className="rounded-lg border border-dashed px-6 py-10 text-center">
          <p className="text-sm font-medium">No settings match “{query.trim()}”.</p>
          <p className={cn("mt-1 text-muted-foreground", SETTING_NOTE_TEXT)}>
            Try the word for what you see, like “dark”, “send” or “preview”.
          </p>
        </div>
      ) : (
        <>
          <p aria-hidden className="mb-2 hidden text-xs text-muted-foreground [@media(pointer:fine)]:block">
            ↑↓ choose · Enter open
          </p>
          <ul
            ref={listRef}
            id={RESULTS_ID}
            role="listbox"
            aria-label="Settings"
            tabIndex={0}
            aria-activedescendant={activeId}
            onKeyDown={onKeyDown}
            className="rounded-lg border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {direct.map(option)}
            {groups.map(
              ({ label, results: grouped }, index) =>
                grouped.length > 0 && (
                  <li key={label} role="presentation" className="border-t first:border-t-0">
                    <ul role="group" aria-labelledby={`${groupId}-${index}`}>
                      <li role="presentation" id={`${groupId}-${index}`} className={SETTING_GROUP_BAND_CLASS}>
                        {label}
                      </li>
                      {grouped.map(option)}
                    </ul>
                  </li>
                )
            )}
          </ul>
        </>
      )}
    </div>
  )
}

function SettingsSearchOption({
  result,
  active,
  href,
  history,
  value,
  onPicked,
}: {
  result: SettingSearchResult
  active: boolean
  href: string
  history: SettingsLinkHistory
  value: string | undefined
  onPicked: () => void
}) {
  const Icon = result.target.kind === "settings" ? SETTINGS_PAGE_CONFIG[result.target.tab].icon : Hash
  return (
    <li role="presentation" className="border-t first:border-t-0">
      <Link
        id={optionId(result)}
        role="option"
        aria-selected={active}
        tabIndex={-1}
        to={href}
        replace={history.replace}
        state={history.state}
        onClick={onPicked}
        className="flex min-h-11 items-start gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/60 aria-selected:bg-muted"
      >
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{result.label}</span>
          {value && <span className={cn("mt-0.5 block text-foreground", SETTING_NOTE_TEXT)}>{value}</span>}
          <span
            className={cn(
              "mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground",
              SETTING_NOTE_TEXT
            )}
          >
            <span>{settingResultTrail(result)}</span>
            <SettingScopeBadges device={result.device} appliesOn={result.appliesOn} />
          </span>
          {result.description && (
            <span className={cn("mt-0.5 line-clamp-2 block text-muted-foreground", SETTING_NOTE_TEXT)}>
              {result.description}
            </span>
          )}
        </span>
        <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      </Link>
    </li>
  )
}

/**
 * Focus for a window's pages: opening lands it in search when a desktop window
 * shows search, else on the heading (on phones search would raise the
 * keyboard), unless a link names a
 * setting to land on; a new page lands it on that page's heading, which
 * announces the page. On phones a page shows search once asked for
 * (`pageSearchOpen`), which closes again on the next page; dismissing it
 * returns focus to its trigger, or the heading.
 */
export function useSettingsPageFocus(
  page: string | null,
  landing: string | null,
  isMobile: boolean,
  content: HTMLElement | null
) {
  const searchRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const searchTriggerRef = useRef<HTMLButtonElement>(null)
  const [pageSearchOpen, setPageSearchOpen] = useState(false)
  const restoreFocus = useRef(false)
  const previousPage = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const previous = previousPage.current
    if (previous === page) return
    previousPage.current = page
    setPageSearchOpen(false)
    if (landing) return
    if (previous === undefined) {
      if (!isMobile && searchRef.current) searchRef.current.focus()
      else headingRef.current?.focus({ preventScroll: true })
      return
    }
    if (content) content.scrollTop = 0
    headingRef.current?.focus()
  }, [page, landing, isMobile, content])

  useEffect(() => {
    if (pageSearchOpen) searchRef.current?.focus()
    else if (restoreFocus.current) {
      restoreFocus.current = false
      ;(searchTriggerRef.current ?? headingRef.current)?.focus()
    }
  }, [pageSearchOpen])

  const dismissPageSearch = () => {
    if (!pageSearchOpen) return
    restoreFocus.current = true
    setPageSearchOpen(false)
  }

  return { searchRef, headingRef, searchTriggerRef, pageSearchOpen, setPageSearchOpen, dismissPageSearch }
}

/** `/` outside a field, or the user's "Search in stream" chord from anywhere, as in macOS System Settings. */
export function isSearchKey(
  event: KeyboardEvent<HTMLElement>,
  capturingShortcut = false,
  shortcutBindings?: Record<string, string>
): boolean {
  if (event.defaultPrevented || capturingShortcut) return false
  const searchBinding = getEffectiveKeyBinding("searchInStream", shortcutBindings)
  if (searchBinding && matchesKeyBinding(event.nativeEvent, searchBinding)) return true
  if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return false
  const target = event.target
  if (target instanceof HTMLElement) {
    if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return false
  }
  return true
}

interface SettingsDesktopLayoutProps {
  /** The dialog's screen-reader description. */
  description: ReactNode
  search: ReactNode
  nav: ReactNode
  eyebrow: string | null
  /** Null while it isn't known yet, such as the overview before permissions. */
  heading: string | null
  headingRef: Ref<HTMLHeadingElement>
  /** Under the heading, such as a page's section jumps. */
  headerExtra?: ReactNode
  onClose: () => void
  contentRef: Ref<HTMLDivElement>
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
}

export function SettingsDesktopLayout({
  description,
  search,
  nav,
  eyebrow,
  heading,
  headingRef,
  headerExtra,
  onClose,
  contentRef,
  onKeyDown,
  children,
}: SettingsDesktopLayoutProps) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(0,1fr)]" onKeyDown={onKeyDown}>
      <aside className="flex min-h-0 flex-col border-r bg-muted/30">
        <div className="space-y-2 px-3 pb-2 pt-3">
          {/* The dialog's name, not a heading: the page title is the window's h2. */}
          <ResponsiveDialogTitle asChild>
            <p className="truncate px-2 text-base font-semibold leading-5">Settings</p>
          </ResponsiveDialogTitle>
          {description}
          {search}
        </div>
        {nav}
      </aside>
      <div className="flex min-h-0 flex-col">
        <header className="border-b px-8 pb-3 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="h-4 truncate text-xs font-medium text-muted-foreground">{eyebrow}</p>
              {heading === null ? (
                <Skeleton className="my-1 h-6 w-40" />
              ) : (
                <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold outline-none">
                  {heading}
                </h2>
              )}
            </div>
            <SettingsCloseButton onClose={onClose} />
          </div>
          {headerExtra && <div className="mt-2">{headerExtra}</div>}
        </header>
        <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto px-8 pb-10 pt-6 scrollbar-thin">
          {children}
        </div>
      </div>
    </div>
  )
}

interface SettingsMobileLayoutProps {
  /** Back to the index, on a page; the index itself has none. */
  back: { href: string; label: string; onClick?: (event: MouseEvent) => void } | null
  eyebrow: string | null
  /** The dialog's accessible title. */
  title: string
  titleRef: Ref<HTMLHeadingElement>
  description: ReactNode
  /** Header buttons before close, such as opening search on a page. */
  actions?: ReactNode
  onClose: () => void
  /** Jumps under search, such as a page's sections or the index's scopes. */
  subheader?: ReactNode
  /** Fixed under the header with `subheader`, so neither scrolls away. */
  search: ReactNode
  contentRef: Ref<HTMLDivElement>
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  children: ReactNode
}

export function SettingsMobileLayout({
  back,
  eyebrow,
  title,
  titleRef,
  description,
  actions,
  onClose,
  subheader,
  search,
  contentRef,
  onKeyDown,
  children,
}: SettingsMobileLayoutProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <header className="flex items-center gap-1 border-b px-2 pb-2 pt-3 sm:pt-2">
        {back ? (
          <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" asChild>
            <Link to={back.href} replace aria-label={back.label} onClick={back.onClick}>
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
        ) : (
          <span className="w-3" />
        )}
        <div className="min-w-0 flex-1">
          {eyebrow && <p className="truncate text-xs font-medium text-muted-foreground">{eyebrow}</p>}
          <ResponsiveDialogTitle asChild>
            <h2 ref={titleRef} tabIndex={-1} className="truncate text-lg font-semibold leading-tight outline-none">
              {title}
            </h2>
          </ResponsiveDialogTitle>
        </div>
        {description}
        {actions}
        <SettingsCloseButton onClose={onClose} />
      </header>
      {(search || subheader) && (
        <div className="space-y-1 border-b px-2 py-2">
          {search && <div className="px-2">{search}</div>}
          {subheader && <div className="px-2">{subheader}</div>}
        </div>
      )}
      <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 pt-4">
        {children}
      </div>
    </div>
  )
}
