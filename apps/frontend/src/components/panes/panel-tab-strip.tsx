import { useContext, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import { flushSync } from "react-dom"
import { Link } from "react-router-dom"
import { ChevronDown, Ellipsis, X } from "lucide-react"
import {
  usePanel,
  useCurrentPane,
  usePanelTabFocusHandoff,
  useSidebar,
  isDraftPanel,
  parseConversationPanel,
  parseComposePanel,
} from "@/contexts"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useStreamName } from "@/hooks/use-stream-name"
import { useThreadAnchorSnippet } from "@/hooks/use-thread-anchor-snippet"
import { useConversationBoardPost } from "@/hooks/use-conversations"
import { useConversationTitle } from "@/hooks/use-conversation-title"
import { closePanelTab, followCurrentPanel } from "@/lib/panel-tabs"
import { fitPanelTabs, splitVisibleTabs, FOCUS_TOGGLE_WIDTH, type PanelTabFit } from "@/lib/panel-tab-fit"
import { cn } from "@/lib/utils"
import { usePaneCovered } from "./pane-host"
import { PaneFocusContext } from "./pane-focus"

/**
 * A section's open tabs as an underline row, standing in for the panel's title
 * while more than one tab is open anywhere. Each tab is a link (switching is
 * navigation, so it's in the URL) and the one on show is underlined and
 * `aria-current`; the underline mutes while another pane is current. The row
 * never scrolls: short of room, the panel's `labels` fold first, then the
 * pane's Focus button, then trailing tabs fold into a "+N" menu.
 */
export function PanelTabStrip({
  workspaceId,
  labels,
  className,
}: {
  workspaceId: string
  labels?: ReactNode
  className?: string
}) {
  const { panelId, layout, section, getTabUrl, closeTab, splitTab, splits, setCurrentPane, focusTab } = usePanel()
  const currentPane = useCurrentPane()
  const { isMobile } = useSidebar()
  const panelIds = section?.ids ?? []
  const activePanelId = section?.active ?? null
  const isCurrent = currentPane !== null && panelIds.includes(currentPane)
  const stripRef = useRef<HTMLElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)
  const covered = usePaneCovered()
  const linkIdPrefix = useId()
  const focusHandoff = usePanelTabFocusHandoff()
  const paneFocus = useContext(PaneFocusContext)
  // Only the Focus button folds: a floating pane's Restore button stays put.
  const focusWidth = paneFocus && panelId && paneFocus.focused !== panelId ? FOCUS_TOGGLE_WIDTH : 0
  const fit = usePanelTabFit(stripRef, labelsRef, panelIds, activePanelId, focusWidth)
  const { shown, folded } = splitVisibleTabs(panelIds, activePanelId, fit.visible)

  useLayoutEffect(() => {
    if (covered || focusHandoff.current === null || focusHandoff.current !== activePanelId) return
    focusHandoff.current = null
    stripRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus()
  }, [covered, activePanelId, panelIds, focusHandoff])

  const handOffFocus = (nextActive: string | null) => {
    if (stripRef.current?.contains(document.activeElement)) focusHandoff.current = nextActive
  }

  return (
    <>
      <nav
        ref={stripRef}
        aria-label="Panel tabs"
        data-focus-folded={!fit.focus || undefined}
        className={cn("peer/tabs relative flex min-w-0 flex-1 self-stretch overflow-hidden", className)}
      >
        {shown.map((id, index) => {
          const active = id === activePanelId
          const linkId = `${linkIdPrefix}-${index}`
          return (
            <div
              key={id}
              className={cn(
                "group relative flex items-center",
                !active && "min-w-24 max-w-48 shrink",
                // The tab on show truncates rather than push itself, or "+N", out of a narrow row.
                active && "min-w-0 shrink-0",
                active && (folded.length > 0 ? "max-w-[min(14rem,calc(100%-3rem))]" : "max-w-[min(14rem,100%)]"),
                active && "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full",
                active && (isCurrent ? "after:bg-primary" : "after:bg-muted-foreground/40")
              )}
            >
              <Link
                id={linkId}
                to={getTabUrl(id)}
                replace
                onClick={(event) => {
                  // The tab on show is the panel's title: following its link would close its overview.
                  // A floating tab's title puts it back in its place.
                  setCurrentPane(id)
                  if (active) {
                    event.preventDefault()
                    if (paneFocus?.focused === id) focusTab(null)
                  } else handOffFocus(id)
                }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-full min-w-0 items-center px-2 text-sm whitespace-nowrap",
                  active && isCurrent && "font-semibold text-foreground",
                  active && !isCurrent && "font-semibold text-muted-foreground",
                  !active && "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">
                  <PanelTabTitle workspaceId={workspaceId} panelId={id} />
                </span>
              </Link>
              <button
                type="button"
                onClick={() => {
                  // A tab closing behind the one on show leaves focus with it, even when the
                  // strip folds several sections; the last tab left takes it on its close button.
                  handOffFocus(
                    id === activePanelId ? followCurrentPanel(layout, closePanelTab(layout, id), id) : activePanelId
                  )
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
          )
        })}
        {folded.length > 0 && (
          <DropdownMenu>
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
      {!isMobile && activePanelId && splits.length > 0 && (
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
                {direction === "right" ? "Split right" : "Split down"}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  )
}

/**
 * Re-fits the row whenever the room, the labels or the tab on show change
 * size. Folded labels stay laid out out of flow, so their width is always known.
 */
function usePanelTabFit(
  stripRef: RefObject<HTMLElement | null>,
  labelsRef: RefObject<HTMLElement | null>,
  panelIds: readonly string[],
  activePanelId: string | null,
  focusWidth: number
): PanelTabFit {
  const [fit, setFit] = useState<PanelTabFit>({ labels: true, focus: true, visible: panelIds.length })
  const labelsShown = useRef(fit.labels)
  labelsShown.current = fit.labels
  const focusShown = useRef(fit.focus)
  focusShown.current = fit.focus
  const tabs = panelIds.length

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const activeTab = strip.querySelector<HTMLElement>('[aria-current="page"]')?.parentElement
    const measure = () => {
      const labelsWidth = Math.ceil(labelsRef.current?.getBoundingClientRect().width ?? 0)
      const room =
        Math.floor(strip.getBoundingClientRect().width) +
        (labelsShown.current ? labelsWidth : 0) +
        (focusShown.current ? focusWidth : 0)
      const activeWidth = Math.ceil(activeTab?.getBoundingClientRect().width ?? 0)
      const next = fitPanelTabs(room, tabs, activeWidth, labelsWidth, focusWidth)
      setFit((current) =>
        current.labels === next.labels && current.focus === next.focus && current.visible === next.visible
          ? current
          : next
      )
    }
    measure()
    // Re-fit before the resized frame paints, so it never shows the old fit clipped.
    const observer = new ResizeObserver(() => flushSync(measure))
    observer.observe(strip)
    if (labelsRef.current) observer.observe(labelsRef.current)
    if (activeTab) observer.observe(activeTab)
    return () => observer.disconnect()
  }, [stripRef, labelsRef, tabs, activePanelId, focusWidth])

  return fit
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
  const composeStreamId = parseComposePanel(panelId)
  if (composeStreamId) {
    return (
      <>
        Draft to <StreamTabTitle workspaceId={workspaceId} streamId={composeStreamId} />
      </>
    )
  }
  const conversationId = parseConversationPanel(panelId)
  if (conversationId) {
    return <ConversationTabTitle workspaceId={workspaceId} conversationId={conversationId} />
  }
  return <StreamTabTitle workspaceId={workspaceId} streamId={panelId} />
}

function StreamTabTitle({ workspaceId, streamId }: { workspaceId: string; streamId: string }) {
  const anchorSnippet = useThreadAnchorSnippet(workspaceId, streamId)
  const name = useStreamName(workspaceId, streamId, "breadcrumb")
  return <>{anchorSnippet ?? name ?? "Thread"}</>
}

function ConversationTabTitle({ workspaceId, conversationId }: { workspaceId: string; conversationId: string }) {
  const { post } = useConversationBoardPost(workspaceId, conversationId)
  const title = useConversationTitle(workspaceId, post?.conversation ?? { streamId: "", topicSummary: null })
  return <>{title ?? "Conversation"}</>
}
