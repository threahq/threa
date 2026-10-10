import { useContext, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { flushSync } from "react-dom"
import { Link } from "react-router-dom"
import { ChevronDown, Ellipsis, X } from "lucide-react"
import {
  usePanel,
  useCurrentPane,
  usePanelTabFocusHandoff,
  isDraftPanel,
  parseConversationPanel,
  parseAsidePanel,
  parseComposePanel,
  parseConversationsPanel,
  parseContextPanel,
  PERSONA_PANE,
  parsePersonaTestPanel,
} from "@/contexts"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useStreamName } from "@/hooks/use-stream-name"
import { useAsideState } from "@/stores/aside-store"
import { useThreadAnchorSnippet } from "@/hooks/use-thread-anchor-snippet"
import { useConversationBoardPost } from "@/hooks/use-conversations"
import { useConversationTitle } from "@/hooks/use-conversation-title"
import { closePanelTab, followCurrentPanel, soleFirstPanelOf } from "@/lib/panel-tabs"
import { fitPanelTabs, splitVisibleTabs, type PanelTabFit } from "@/lib/panel-tab-fit"
import { cn } from "@/lib/utils"
import { pageTitleOf } from "@/lib/page-panes"
import { usePaneCovered } from "./pane-host"
import { PaneFocusContext } from "./pane-focus"
import { endTabDrag, startTabDrag, useStripCaret, useStripDropZone } from "./pane-drop"
import { PanelTabMenu, SPLIT_LABELS, closeTabItems, type PanelTabMenuItem } from "./panel-tab-menu"

/**
 * A section's open tabs as an underline row, standing in for the panel's title
 * while more than one tab is open anywhere. Each tab is a link (switching is
 * navigation, so it's in the URL) and the one on show is underlined and
 * `aria-current`; the underline mutes while another pane is current. The row
 * never scrolls: short of room, the panel's `labels` fold first, then
 * trailing tabs fold into a "+N" menu.
 */
export function PanelTabStrip({
  workspaceId,
  labels,
  className,
  splitsInPaneMenu = false,
}: {
  workspaceId: string
  labels?: ReactNode
  className?: string
  /** The pane's own actions menu offers its splits, so the row drops its "Tab actions" menu. */
  splitsInPaneMenu?: boolean
}) {
  const { layout, section, getTabUrl, closeTab, closeTabs, canCloseTab, splitTab, splits, setCurrentPane, focusTab } =
    usePanel()
  const currentPane = useCurrentPane()
  const panelIds = section?.ids ?? []
  const activePanelId = section?.active ?? null
  const isCurrent = currentPane !== null && panelIds.includes(currentPane)
  const stripRef = useRef<HTMLElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const covered = usePaneCovered()
  const linkIdPrefix = useId()
  const focusHandoff = usePanelTabFocusHandoff()
  const paneFocus = useContext(PaneFocusContext)
  const fit = usePanelTabFit(stripRef, labelsRef, panelIds, activePanelId)
  const { shown, folded } = splitVisibleTabs(panelIds, activePanelId, fit.visible)
  const dropZone = useStripDropZone(activePanelId)
  const caret = useStripCaret(activePanelId)

  useLayoutEffect(() => {
    if (covered || focusHandoff.current === null || focusHandoff.current !== activePanelId) return
    focusHandoff.current = null
    stripRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus()
  }, [covered, activePanelId, panelIds, focusHandoff])

  const handOffFocus = (nextActive: string | null) => {
    if (stripRef.current?.contains(document.activeElement)) focusHandoff.current = nextActive
  }
  // The sole first pane shows neither a strip nor a close button, so nothing there would take a handoff.
  const activeAfterClosing = (ids: readonly string[]) => {
    if (activePanelId === null || !ids.includes(activePanelId)) return activePanelId
    const next = ids.reduce(closePanelTab, layout)
    const active = followCurrentPanel(layout, next, activePanelId)
    return active === soleFirstPanelOf(next) ? null : active
  }
  // The menu holds focus while it is open, so its close hands off to the tab left on show unconditionally.
  const closeFromMenu = (ids: readonly string[]) => {
    focusHandoff.current = activeAfterClosing(ids)
    closeTabs(ids)
  }
  const tabMenuItems = (id: string): PanelTabMenuItem[] => [
    ...closeTabItems({ ids: panelIds, id, canClose: canCloseTab, close: closeFromMenu }),
    ...splits.map((direction, index) => ({
      id: `split-${direction}`,
      label: SPLIT_LABELS[direction],
      separatorBefore: index === 0,
      onSelect: () => {
        focusHandoff.current = id
        splitTab(id, direction)
      },
    })),
  ]

  return (
    <>
      <nav
        ref={stripRef}
        aria-label="Panel tabs"
        className={cn("relative flex min-w-0 flex-1 self-stretch overflow-hidden", className)}
        {...dropZone}
      >
        {shown.map((id, index) => {
          const active = id === activePanelId
          const linkId = `${linkIdPrefix}-${index}`
          return (
            <PanelTabMenu key={id} items={tabMenuItems(id)}>
              <div
                data-tab-id={id}
                className={cn(
                  "group relative flex items-center",
                  !active && "min-w-24 max-w-48 shrink",
                  active && "max-w-56 shrink",
                  // The tab on show keeps the others' floor, short of room for it beside "+N".
                  active && (folded.length > 0 ? "min-w-[min(6rem,calc(100%_-_3rem))]" : "min-w-[min(6rem,100%)]"),
                  active && "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
                  active && (isCurrent ? "after:bg-primary" : "after:bg-muted-foreground/40")
                )}
              >
                {caret?.before === id && <StripCaret side="left" />}
                {caret?.before === null && index === shown.length - 1 && <StripCaret side="right" />}
                <Link
                  id={linkId}
                  to={getTabUrl(id)}
                  replace
                  draggable
                  onDragStart={(event) => startTabDrag(event, workspaceId, id, event.currentTarget.textContent ?? "")}
                  onDragEnd={endTabDrag}
                  onClick={(event) => {
                    // The tab on show is the panel's title: following its link would close its overview.
                    // A floating tab's title puts it back in its place.
                    setCurrentPane(id)
                    if (active) {
                      event.preventDefault()
                      if (paneFocus?.focused.includes(id)) focusTab(null)
                    } else handOffFocus(id)
                  }}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex h-full min-w-0 flex-1 items-center px-2 text-sm whitespace-nowrap",
                    active && isCurrent && "font-semibold text-foreground",
                    active && !isCurrent && "font-semibold text-muted-foreground",
                    !active && "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span data-tab-title className="truncate">
                    <PanelTabTitle workspaceId={workspaceId} panelId={id} />
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    // A tab closing behind the one on show leaves focus with it, even when the
                    // strip folds several sections; the last tab left takes it on its close button.
                    handOffFocus(activeAfterClosing([id]))
                    closeTab(id)
                  }}
                  aria-label="Close tab"
                  aria-describedby={linkId}
                  className={cn(
                    "-ml-1 mr-1 grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100",
                    !active && "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  )}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </PanelTabMenu>
          )
        })}
        {folded.length > 0 && (
          <DropdownMenu>
            <PanelTabMenu
              items={[
                {
                  id: "folded",
                  label: "Close hidden tabs",
                  disabled: !folded.some(canCloseTab),
                  onSelect: () => closeFromMenu(folded),
                },
                {
                  id: "all",
                  label: "Close all",
                  disabled: !panelIds.some(canCloseTab),
                  onSelect: () => closeFromMenu(panelIds),
                },
              ]}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`${folded.length} more ${folded.length === 1 ? "tab" : "tabs"}`}
                  className="flex w-12 shrink-0 items-center justify-center gap-0.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  +{folded.length}
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
            </PanelTabMenu>
            <DropdownMenuContent
              align="start"
              onCloseAutoFocus={(event) => {
                if (focusHandoff.current !== null) event.preventDefault()
              }}
            >
              {folded.map((id) => (
                <DropdownMenuItem key={id} asChild>
                  <Link
                    to={getTabUrl(id)}
                    replace
                    onClick={() => {
                      setCurrentPane(id)
                      focusHandoff.current = id
                    }}
                    className="max-w-64"
                  >
                    <span className="truncate">
                      <PanelTabTitle workspaceId={workspaceId} panelId={id} />
                    </span>
                  </Link>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </nav>
      {labels && (
        <div ref={labelsRef} className={cn("flex shrink-0 items-center", !fit.labels && "invisible absolute")}>
          {labels}
        </div>
      )}
      {activePanelId && splits.length > 0 && !splitsInPaneMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Tab actions"
              className="mr-1 grid h-6 w-6 shrink-0 place-items-center self-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Ellipsis className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              if (focusHandoff.current !== null) event.preventDefault()
            }}
          >
            {splits.map((direction) => (
              <DropdownMenuItem
                key={direction}
                onSelect={() => {
                  // The split-off tab's row takes focus in its new section, as the menu that held it closes.
                  focusHandoff.current = activePanelId
                  splitTab(activePanelId, direction)
                }}
              >
                {SPLIT_LABELS[direction]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  )
}

/** Where a dragged tab would land in the strip: before a tab, or after the last one shown. */
function StripCaret({ side }: { side: "left" | "right" }) {
  return (
    <span
      aria-hidden
      data-testid="strip-drop-caret"
      className={cn(
        "pointer-events-none absolute inset-y-1.5 z-10 w-0.5 rounded-full bg-primary",
        side === "left" ? "left-0" : "right-0"
      )}
    />
  )
}

/**
 * Re-fits the row whenever the room, the labels or the tab on show change
 * size. Folded labels stay laid out out of flow, so their width is always known,
 * and the tab on show is measured untruncated, so shrinking it never re-shows them.
 */
function usePanelTabFit(
  stripRef: RefObject<HTMLElement | null>,
  labelsRef: RefObject<HTMLElement | null>,
  panelIds: readonly string[],
  activePanelId: string | null
): PanelTabFit {
  const [fit, setFit] = useState<PanelTabFit>({ labels: true, visible: panelIds.length })
  const labelsShown = useRef(fit.labels)
  labelsShown.current = fit.labels
  const tabs = panelIds.length

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const activeTab = strip.querySelector<HTMLElement>('[aria-current="page"]')?.parentElement
    const measure = () => {
      const labelsWidth = Math.ceil(labelsRef.current?.getBoundingClientRect().width ?? 0)
      const room = Math.floor(strip.getBoundingClientRect().width) + (labelsShown.current ? labelsWidth : 0)
      const activeWidth = activeTab ? Math.ceil(naturalTabWidth(activeTab)) : 0
      const next = fitPanelTabs(room, tabs, activeWidth, labelsWidth)
      setFit((current) => (current.labels === next.labels && current.visible === next.visible ? current : next))
    }
    measure()
    // Re-fit before the resized frame paints, so it never shows the old fit clipped.
    const observer = new ResizeObserver(() => flushSync(measure))
    observer.observe(strip)
    if (labelsRef.current) observer.observe(labelsRef.current)
    if (activeTab) observer.observe(activeTab)
    return () => observer.disconnect()
  }, [stripRef, labelsRef, tabs, activePanelId])

  return fit
}

/** The tab's width were it not shrunk to fit: its title untruncated, up to its own max width. */
function naturalTabWidth(tab: HTMLElement): number {
  const title = tab.querySelector<HTMLElement>("[data-tab-title]")
  const width = tab.getBoundingClientRect().width + (title ? title.scrollWidth - title.clientWidth : 0)
  return Math.min(width, parseFloat(getComputedStyle(tab).maxWidth) || width)
}

/**
 * Lands focus handed off by a tab row that closed down to this panel alone on
 * the panel's own close (or phone back) button, which takes the returned ref.
 */
export function usePanelCloseFocusLanding() {
  const { panelId, tabbed } = usePanel()
  const covered = usePaneCovered()
  const focusHandoff = usePanelTabFocusHandoff()
  const closeRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (tabbed || covered || focusHandoff.current === null || focusHandoff.current !== panelId) return
    focusHandoff.current = null
    closeRef.current?.focus()
  }, [tabbed, covered, panelId, focusHandoff])
  return closeRef
}

export function PanelTabTitle({ workspaceId, panelId }: { workspaceId: string; panelId: string }) {
  if (isDraftPanel(panelId)) return <>New thread</>
  const pageTitle = pageTitleOf(panelId)
  if (pageTitle !== null) return <>{pageTitle}</>
  if (panelId === PERSONA_PANE) return <>Edit persona</>
  if (parsePersonaTestPanel(panelId)) return <>Test chat</>
  if (parseAsidePanel(panelId)) return <AsideTabTitle workspaceId={workspaceId} />
  const composeStreamId = parseComposePanel(panelId)
  if (composeStreamId) {
    return (
      <>
        Draft to <StreamTabTitle workspaceId={workspaceId} streamId={composeStreamId} />
      </>
    )
  }
  const conversationsStreamId = parseConversationsPanel(panelId)
  if (conversationsStreamId) {
    return (
      <>
        Conversations in <StreamTabTitle workspaceId={workspaceId} streamId={conversationsStreamId} />
      </>
    )
  }
  const context = parseContextPanel(panelId)
  if (context) {
    return (
      <>
        In <StreamTabTitle workspaceId={workspaceId} streamId={context.streamId} />
      </>
    )
  }
  const conversationId = parseConversationPanel(panelId)
  if (conversationId) {
    return <ConversationTabTitle workspaceId={workspaceId} conversationId={conversationId} />
  }
  return <StreamTabTitle workspaceId={workspaceId} streamId={panelId} />
}

function AsideTabTitle({ workspaceId }: { workspaceId: string }) {
  const asideId = useAsideState()?.asideId
  return <>{useStreamName(workspaceId, asideId ?? "", "breadcrumb") ?? "Aside"}</>
}

function StreamTabTitle({ workspaceId, streamId }: { workspaceId: string; streamId: string }) {
  const anchorSnippet = useThreadAnchorSnippet(workspaceId, streamId)
  const name = useStreamName(workspaceId, streamId, "breadcrumb")
  return <>{anchorSnippet ?? name ?? "Thread"}</>
}

function ConversationTabTitle({ workspaceId, conversationId }: { workspaceId: string; conversationId: string }) {
  const { post } = useConversationBoardPost(workspaceId, conversationId)
  const title = useConversationTitle(workspaceId, post?.conversation ?? { streamId: "", topicSummary: null })
  if (!post) return <>Conversation</>
  return <>{title ?? "Untitled conversation"}</>
}
