import { useSearchParams } from "react-router-dom"
import { useCoverClose } from "@/hooks/use-cover-close"
import { CONTEXT_COVER } from "@/lib/covers"

/**
 * Open state of the "In this stream" overview. `?context` doubles as open-state
 * (present ⇒ open) and the selected category filter; it belongs to the
 * front-most stream — the panel's while one is open (`PANEL_COVER` clears it
 * with the panel), the page's otherwise.
 */
export function useStreamContextOpen(): [boolean, (open: boolean) => void] {
  const [searchParams, setSearchParams] = useSearchParams()
  const closeContext = useCoverClose(CONTEXT_COVER)
  const setOpen = (open: boolean) => {
    if (!open) {
      closeContext()
      return
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set("context", "all")
      return next
    })
  }
  return [searchParams.get("context") !== null, setOpen]
}
