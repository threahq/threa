import { useCallback, useEffect, useRef } from "react"
import { useLocation, useNavigate, useNavigationType, useSearchParams } from "react-router-dom"
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
 * a same-URL push on top, which is an overlay's sentinel entry
 * (`history-back-close.tsx`): neither touches the entry beneath. The
 * cold-launch rebuild (`useRebuildLaunchAncestors`) batches its hops into one
 * commit, so the previous location never sees the entry it pushed on top of;
 * its push carries `popsToClose: <param>` as the attestation instead.
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
  useEffect(() => {
    if (location.key === previous.current?.key) return
    const params = new URLSearchParams(location.search)
    const url = `${location.pathname}?${params.toString()}`
    const open = params.has(cover[0])
    for (const param of cover) params.delete(param)
    const beneath = `${location.pathname}?${params.toString()}`
    const before = previous.current
    previous.current = { key: location.key, url }
    if (!open || !before) return
    const attested = (location.state as PopsToCloseState | null)?.popsToClose === cover[0]
    const pushedOverBeneath = navigationType === "PUSH" && (attested || before.url === beneath)
    const onTop = (navigationType === "REPLACE" || url === before.url) && claimed.current.has(before.key)
    if (pushedOverBeneath || onTop) claimed.current.add(location.key)
  }, [cover, location.key, location.pathname, location.search, location.state, navigationType])

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
