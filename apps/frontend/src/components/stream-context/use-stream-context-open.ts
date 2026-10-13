import { useSearchParams } from "react-router-dom"
import { useCoverClose } from "@/hooks/use-cover-close"
import { CONTEXT_COVER } from "@/lib/covers"

/**
 * Open state of the "In this stream" overview. `?context` doubles as open-state
 * (present ⇒ open) and the selected category filter. It and `?m` belong to one
 * pane at a time (`usePanel().ownsCover`), so opening the overview drops a deep
 * link another pane landed on rather than sending this one looking for it.
 */
export function useStreamContextOpen(): [boolean, (open: boolean) => void] {
  const [searchParams, setSearchParams] = useSearchParams()
  const closeContext = useCoverClose(CONTEXT_COVER)
  const setOpen = (open: boolean) => {
    if (!open) {
      closeContext()
      return
    }
    if (searchParams.has("context") && !searchParams.has("m")) return
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set("context", prev.get("context") ?? "all")
      next.delete("m")
      return next
    })
  }
  return [searchParams.get("context") !== null, setOpen]
}
