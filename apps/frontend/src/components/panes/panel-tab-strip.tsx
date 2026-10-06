import { useId, useLayoutEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { X } from "lucide-react"
import { usePanel, usePanelTabFocusHandoff, isDraftPanel, parseConversationPanel } from "@/contexts"
import { useStreamName } from "@/hooks/use-stream-name"
import { useThreadAnchorSnippet } from "@/hooks/use-thread-anchor-snippet"
import { useConversationBoardPost } from "@/hooks/use-conversations"
import { useConversationTitle } from "@/hooks/use-conversation-title"
import { closePanelTab } from "@/lib/panel-tabs"
import { cn } from "@/lib/utils"
import { usePaneCovered } from "./pane-host"

/**
 * The panel's open tabs as an underline row, standing in for the panel's title
 * while more than one is open. Each tab is a link (switching is navigation, so
 * it's in the URL) and the one on show is underlined and `aria-current`.
 */
export function PanelTabStrip({ workspaceId, className }: { workspaceId: string; className?: string }) {
  const { panelIds, activePanelId, getTabUrl, closeTab } = usePanel()
  const stripRef = useRef<HTMLElement>(null)
  const covered = usePaneCovered()
  const linkIdPrefix = useId()
  const focusHandoff = usePanelTabFocusHandoff()

  // Keep the tab on show in view when the row scrolls (a phone, many tabs),
  // close button included, and again as titles resolve and widen the tabs.
  // `scrollLeft` rather than `scrollIntoView`, which would also scroll the
  // overflow-hidden panes around the strip.
  useLayoutEffect(() => {
    const strip = stripRef.current
    const tab = strip?.querySelector<HTMLElement>('[aria-current="page"]')?.parentElement
    if (!strip || !tab) return
    const keepInView = () => {
      const left = tab.offsetLeft
      const right = left + tab.offsetWidth
      if (left < strip.scrollLeft) strip.scrollLeft = left
      else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth
    }
    keepInView()
    const observer = new ResizeObserver(keepInView)
    for (const child of strip.children) observer.observe(child)
    return () => observer.disconnect()
  }, [activePanelId, panelIds])

  useLayoutEffect(() => {
    if (covered || focusHandoff.current === null || focusHandoff.current !== activePanelId) return
    focusHandoff.current = null
    stripRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus()
  }, [covered, activePanelId, panelIds, focusHandoff])

  const handOffFocus = (nextActive: string | null) => {
    if (stripRef.current?.contains(document.activeElement)) focusHandoff.current = nextActive
  }

  return (
    <nav
      ref={stripRef}
      aria-label="Panel tabs"
      className={cn(
        "relative flex min-w-0 flex-1 self-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
    >
      {panelIds.map((id, index) => {
        const active = id === activePanelId
        const linkId = `${linkIdPrefix}-${index}`
        return (
          <div
            key={id}
            className={cn(
              "group relative flex min-w-24 items-center",
              active ? "max-w-56 shrink-0" : "max-w-48 shrink",
              active && "after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
            )}
          >
            <Link
              id={linkId}
              to={getTabUrl(id)}
              replace
              onClick={(event) => {
                // The tab on show is the panel's title: following its link would close its overview.
                if (active) event.preventDefault()
                else handOffFocus(id)
              }}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-full min-w-0 items-center px-2 text-sm whitespace-nowrap",
                active ? "font-semibold text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <span className="truncate">
                <PanelTabTitle workspaceId={workspaceId} panelId={id} />
              </span>
            </Link>
            <button
              type="button"
              onClick={() => {
                // A row survives only while two tabs stay open.
                if (panelIds.length > 2)
                  handOffFocus(closePanelTab({ ids: panelIds, active: activePanelId }, id).active)
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
    </nav>
  )
}

function PanelTabTitle({ workspaceId, panelId }: { workspaceId: string; panelId: string }) {
  if (isDraftPanel(panelId)) return <>New thread</>
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
