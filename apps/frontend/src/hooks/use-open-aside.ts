import { useCallback, useContext, useEffect, useRef } from "react"
import { UNSAFE_DataRouterContext, UNSAFE_NavigationContext, matchPath, type Location } from "react-router-dom"
import { toast } from "sonner"
import { ContextRefKinds, StreamTypes, draftStreamScope, type ContextRef } from "@threahq/types"
import { boardReplyDraftKey } from "@/lib/board/draft-keys"
import { useCreateStream } from "./use-streams"
import { buildAsideBag, buildViewportRef } from "@/lib/aside/snapshot"
import { asideHostKey, openAside } from "@/stores/aside-store"
import { capture } from "@/lib/analytics/posthog"
import { PANEL_PARAM, fullPanelLayout, panelIdsOf, parsePanelLayout } from "@/lib/panel-tabs"

/** The panes a stream page shows; null off the stream page. */
function panesAt({ pathname, search }: Location): string[] | null {
  const path = matchPath("/w/:workspaceId/s/:streamId", pathname)?.params.streamId
  if (path === undefined) return null
  return panelIdsOf(fullPanelLayout(path, parsePanelLayout(new URLSearchParams(search).get(PANEL_PARAM))))
}

/**
 * The route as it is when called, with no render subscription: an opener sits
 * in every message row, and `useLocation` would re-render each row on every
 * pane change for a value the row only needs when the user opens an aside.
 */
function useLatestLocation(): () => Location {
  const router = useContext(UNSAFE_DataRouterContext)?.router
  // Outside a data router (`MemoryRouter` in tests) the navigator is the history object, which carries the location.
  const { navigator } = useContext(UNSAFE_NavigationContext)
  return useCallback(() => {
    const location = router ? router.state.location : (navigator as { location?: Location }).location
    if (!location) throw new Error("useLatestLocation needs a data router or a history navigator")
    return location
  }, [router, navigator])
}

/**
 * Where an aside is opened from. A timeline surface (channel, DM, scratchpad,
 * thread panel) snapshots what the host scroller shows; a conversation surface
 * (board card, conversation panel) passes the conversation itself, which the
 * resolver already expands end to end.
 */
export type AsideOrigin =
  | { kind: "stream"; hostStreamId: string; anchorId?: string }
  | { kind: "conversation"; hostStreamId: string; conversationId: string; anchorId?: string }

/** The scroller of the host stream's mounted timeline (`StreamContent` stamps it), if any. */
function findStreamScroller(streamId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-stream-scroller="${streamId}"]`)
}

/** The composer a hand-off from this aside files into. */
function originScopeOf(origin: AsideOrigin): string {
  return origin.kind === "conversation"
    ? boardReplyDraftKey(origin.conversationId)
    : draftStreamScope(origin.hostStreamId)
}

function buildOriginRefs(origin: AsideOrigin): ContextRef[] {
  if (origin.kind === "conversation") {
    return [
      {
        kind: ContextRefKinds.CONVERSATION,
        conversationId: origin.conversationId,
        streamId: origin.hostStreamId,
        originMessageId: origin.anchorId,
      },
    ]
  }
  const scroller = findStreamScroller(origin.hostStreamId)
  const ref = scroller ? buildViewportRef(scroller, origin.hostStreamId) : null
  return ref ? [ref] : []
}

/**
 * Open a new aside on the current page: create the aside stream (viewport
 * captured once, here, before the create call) and show it. Auto-titled by the backend naming path, so no `displayName`.
 * Creation failure toasts (the one loud signal); success is the surface itself.
 */
export function useOpenAside(workspaceId: string) {
  const { mutateAsync: createStream } = useCreateStream(workspaceId)
  const latestLocation = useLatestLocation()
  // The create is a round trip; the page can be left (or the account switched),
  // or the host stream's pane closed, before it lands. Writing the surface then
  // would strand an aside on a host that is gone — `dropAsideForHost` and
  // `dropAsideForHostStream` already ran against an empty store — and it would
  // reappear on returning to it. The route is re-read once the create lands
  // and compared with the one it started from.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  return useCallback(
    async (origin: AsideOrigin) => {
      capture("aside_opened", { kind: origin.kind })
      const hostKey = asideHostKey(latestLocation().pathname)
      const hostShown = panesAt(latestLocation())?.includes(origin.hostStreamId) ?? false
      const refs = buildOriginRefs(origin)
      let aside
      try {
        aside = await createStream({
          type: StreamTypes.ASIDE,
          parentStreamId: origin.hostStreamId,
          parentAnchorId: origin.anchorId,
          ...(origin.kind === "conversation" && { conversationId: origin.conversationId }),
          ...(refs.length > 0 && { contextBag: buildAsideBag(refs) }),
        })
      } catch (err) {
        toast.error("Couldn't open an aside. Please try again.")
        throw err
      }
      if (!mounted.current || asideHostKey(latestLocation().pathname) !== hostKey) return
      if (hostShown && !panesAt(latestLocation())?.includes(origin.hostStreamId)) return
      openAside({
        hostKey,
        hostStreamId: origin.hostStreamId,
        asideId: aside.id,
        originScope: originScopeOf(origin),
      })
    },
    [createStream, latestLocation]
  )
}

/** What the anchor row hands back when re-opening its aside. */
export interface ResumeAsideParams {
  asideId: string
  hostStreamId: string
  /** Set when the aside was opened on a conversation, so a hand-off files back into it. */
  conversationId?: string
}

/** Re-open an existing aside from its anchor row. */
export function useResumeAside() {
  const latestLocation = useLatestLocation()
  return useCallback(
    (params: ResumeAsideParams) => {
      openAside({
        hostKey: asideHostKey(latestLocation().pathname),
        hostStreamId: params.hostStreamId,
        asideId: params.asideId,
        originScope: params.conversationId
          ? boardReplyDraftKey(params.conversationId)
          : draftStreamScope(params.hostStreamId),
      })
    },
    [latestLocation]
  )
}
