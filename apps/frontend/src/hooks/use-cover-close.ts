import { useCallback, useContext, useEffect, useMemo, useRef } from "react"
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
  return useCoverHistory(cover).close
}

/** A canonical spelling of a URL, so entries compare by what they show. */
function entryUrl(pathname: string, params: URLSearchParams): string {
  const sorted = new URLSearchParams(params)
  sorted.sort()
  return `${pathname}?${sorted.toString()}`
}

/**
 * {@link useCoverClose}, plus `closeTo`: takes part of a cover off (one of the
 * panel's tabs) and lands on `next`. It pops when the entry beneath shows
 * exactly `next`, so Back never brings the closed part back; otherwise it
 * rewrites in place. Each entry's beneath is the one it was pushed over,
 * inherited by a replace or a same-URL push on top, and the stripped view for
 * an attested hop.
 */
export function useCoverHistory(cover: Cover): { close: () => void; closeTo: (next: URLSearchParams) => void } {
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType()
  const [, setSearchParams] = useSearchParams()

  const claimed = useRef(new Set<string>())
  const beneathOf = useRef(new Map<string, string>())
  const previous = useRef<{ key: string; url: string; entry: string } | null>(null)
  const observe = useCallback(
    (at: Location, action: NavigationType) => {
      if (at.key === previous.current?.key) return
      const params = new URLSearchParams(at.search)
      const url = `${at.pathname}?${params.toString()}`
      const entry = entryUrl(at.pathname, params)
      const open = params.has(cover[0])
      for (const param of cover) params.delete(param)
      const beneath = `${at.pathname}?${params.toString()}`
      const before = previous.current
      previous.current = { key: at.key, url, entry }
      // An attested entry stays attested however it is reached: the rebuild's
      // inner hops are first seen by popping back onto them.
      const attested = (at.state as PopsToCloseState | null)?.popsToClose === cover[0]
      const onTopOfBefore = before !== null && (action === "REPLACE" || url === before.url)
      if (attested) beneathOf.current.set(at.key, entryUrl(at.pathname, params))
      else if (before !== null && action !== "POP") {
        const inherited = onTopOfBefore ? beneathOf.current.get(before.key) : before.entry
        if (inherited !== undefined) beneathOf.current.set(at.key, inherited)
      }
      if (!open) return
      const pushedOverBeneath = action === "PUSH" && before?.url === beneath
      const onTop = onTopOfBefore && claimed.current.has(before.key)
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

  const close = useCallback(() => {
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

  const closeTo = useCallback(
    (next: URLSearchParams) => {
      const open = new URLSearchParams(location.search).has(cover[0])
      // Consumed like a claim, so a second close before the pop commits can't pop twice.
      if (open && beneathOf.current.get(location.key) === entryUrl(location.pathname, next)) {
        beneathOf.current.delete(location.key)
        navigate(-1)
        return
      }
      setSearchParams(next, { replace: true })
    },
    [cover, location.key, location.pathname, location.search, navigate, setSearchParams]
  )

  return useMemo(() => ({ close, closeTo }), [close, closeTo])
}
