import { useCallback, useEffect, useMemo, useState } from "react"
import type { JSONContent } from "@threahq/types"
import { contentSignature } from "@/lib/display-stamps"
import { surfacePrivacyConfirmToast } from "@/lib/share-privacy-toast"
import { useStableCallback } from "./use-stable-callback"

/**
 * A 409 asked consent for content the composer still holds. The question lasts
 * while that content (display stamps aside) stays under the same toast id;
 * editing, switching target, or unmounting withdraws it. Confirming sends what
 * the composer holds now.
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
  onConfirm: () => void
}): { block: (blockedContent: JSONContent) => void; clear: () => void } {
  // A fresh object per 409, so a refusal after a swipe-dismissed toast surfaces it again.
  const [blocked, setBlocked] = useState<{ toastId: string; signature: string } | null>(null)
  const confirm = useStableCallback(onConfirm)
  const signature = useMemo(() => (blocked ? contentSignature(content) : null), [blocked, content])

  useEffect(() => {
    if (!blocked) return
    if (blocked.toastId !== toastId || blocked.signature !== signature) {
      setBlocked(null)
      return
    }
    return surfacePrivacyConfirmToast(toastId, {
      confirmLabel,
      onConfirm: () => {
        setBlocked(null)
        confirm()
      },
      onCancel: () => setBlocked(null),
    })
  }, [blocked, signature, toastId, confirmLabel, confirm])

  const block = useCallback(
    (blockedContent: JSONContent) => setBlocked({ toastId, signature: contentSignature(blockedContent) }),
    [toastId]
  )
  const clear = useCallback(() => setBlocked(null), [])
  return { block, clear }
}
