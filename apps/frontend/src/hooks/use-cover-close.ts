import { useCallback, useContext, useEffect, useRef } from "react"
import {
  UNSAFE_DataRouterContext,
  useLocation,
  useNavigate,
  useNavigationType,
  useSearchParams,
  type Location,
  type NavigationType,
} from "react-router-dom"
import type { Cover, PopsToCloseState } from "@/lib/covers"

/**
 * Closes a URL-owned cover the way a native screen closes: when the history
 * entry underneath is this view without the cover, closing pops it, so a later
 * back press never resurfaces a dismissed cover and never lands on a duplicate
 * of the page; otherwise the params come off in place.
 *
 * Whether an entry qualifies is derived from the navigation that produced it
 * rather than recorded on open, because most covers open through `<Link>`
 * (INV-40) and never call an open function. Popping a deep link or a reload
 * would navigate off the page, possibly out of the app, so only a same-view
 * PUSH qualifies. The claim is kept per history entry key, so it survives a
 * forward navigation and a back onto the entry. It carries over to a replace
 * on top (the gallery swiping to the next item, a settings tab change) and to
 * a same-URL push on top, an overlay's sentinel entry
 * (`history-back-close.tsx`): neither touches the entry beneath. The
 * cold-launch rebuild (`useRebuildLaunchAncestors`) batches its hops into one
 * commit, so the previous location never sees the entry it pushed on top of;
 * its hops carry `popsToClose: <param>` as the attestation instead.
 *
 * Navigations are observed from the data router's own state, not only from
 * the committed location: react-router commits inside a transition, so a
 * replace and a push issued in one tick (the workspace root redirecting to
 * its default stream while a cover opens on top) reach the committed location
 * as a single change, and the entry beneath the push is never seen there.
 * The committed location remains the feed under a plain `<MemoryRouter>`.
 *
 * The entry beneath must carry NONE of the cover's params, not merely other
 * values: closing means "cover gone" (a nested thread's affordance reads
 * "Return to #channel"), so a cover opened over another instance of itself
 * closes in place. Back still steps through them one at a time.
 */
export function useCoverClose(cover: Cover): () => void {
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const [, setSearchParams] = useSearchParams()

  const claimed = useRef(new Set<string>())
  const previous = useRef<{ key: string; url: string } | null>(null)
  const observe = useCallback(
    (at: Location, action: NavigationType) => {
      if (at.key === previous.current?.key) return
      const params = new URLSearchParams(at.search)
      const url = `${at.pathname}?${params.toString()}`
      const open = params.has(cover[0])
      for (const param of cover) params.delete(param)
      const beneath = `${at.pathname}?${params.toString()}`
      const before = previous.current
      previous.current = { key: at.key, url }
      if (!open) return
      // An attested entry stays attested however it is reached: the rebuild's
      // inner hops are first seen by popping back onto them.
      const attested = (at.state as PopsToCloseState | null)?.popsToClose === cover[0]
      const pushedOverBeneath = action === "PUSH" && before?.url === beneath
      const onTop = before !== null && (action === "REPLACE" || url === before.url) && claimed.current.has(before.key)
      if (attested || pushedOverBeneath || onTop) claimed.current.add(at.key)
    },
    [cover]
  )

  const router = useContext(UNSAFE_DataRouterContext)?.router ?? null
  useEffect(() => {
    if (!router) return
    observe(router.state.location, router.state.historyAction)
    return router.subscribe((state) => observe(state.location, state.historyAction))
  }, [observe, router])

  useEffect(() => {
    if (router) return
    observe(location, navigationType)
  }, [location, navigationType, observe, router])

  return useCallback(() => {
    if (claimed.current.delete(location.key)) {
      navigate(-1)
      return
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const param of cover) next.delete(param)
        return next
      },
      { replace: true }
    )
  }, [cover, location.key, navigate, setSearchParams])
}
