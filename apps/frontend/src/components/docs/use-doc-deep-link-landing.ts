import { useEffect } from "react"
import { useSearchParams } from "react-router-dom"
import { requestBlockFocus } from "@/lib/docs/block-focus"

/**
 * A doc's `?m=` deep link names the block to land on (a doc mention's link). The param is taken off the
 * URL once handed over, without a history entry, so following the same link again lands again.
 */
export function useDocDeepLinkLanding(docId: string | null, blockId: string | null): void {
  const [, setSearchParams] = useSearchParams()
  useEffect(() => {
    if (!docId || !blockId) return
    requestBlockFocus(docId, blockId)
    setSearchParams(
      (prev) => {
        prev.delete("m")
        return prev
      },
      { replace: true }
    )
  }, [docId, blockId, setSearchParams])
}
