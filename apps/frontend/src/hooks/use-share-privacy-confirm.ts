import { useCallback, useEffect, useState } from "react"
import type { JSONContent } from "@threahq/types"
import { surfacePrivacyConfirmToast } from "@/lib/share-privacy-toast"
import { useStableCallback } from "./use-stable-callback"

/**
 * A 409 asked consent for content the composer still holds. The question lasts
 * while that exact content stays under the same toast id; editing, switching
 * target, or unmounting withdraws it.
 */
export function useSharePrivacyConfirm({
  toastId,
  content,
  confirmLabel,
  onConfirm,
}: {
  toastId: string
  content: JSONContent
  confirmLabel: string
  onConfirm: (blockedContent: JSONContent) => void
}): { block: (blockedContent: JSONContent) => void; clear: () => void } {
  // A fresh object per 409, so a refusal after a swipe-dismissed toast surfaces it again.
  const [blocked, setBlocked] = useState<{ toastId: string; content: JSONContent } | null>(null)
  const confirm = useStableCallback(onConfirm)

  useEffect(() => {
    if (!blocked) return
    if (blocked.content !== content || blocked.toastId !== toastId) {
      setBlocked(null)
      return
    }
    return surfacePrivacyConfirmToast(toastId, {
      confirmLabel,
      onConfirm: () => {
        setBlocked(null)
        confirm(blocked.content)
      },
      onCancel: () => setBlocked(null),
    })
  }, [blocked, content, toastId, confirmLabel, confirm])

  const block = useCallback(
    (blockedContent: JSONContent) => setBlocked({ toastId, content: blockedContent }),
    [toastId]
  )
  const clear = useCallback(() => setBlocked(null), [])
  return { block, clear }
}
