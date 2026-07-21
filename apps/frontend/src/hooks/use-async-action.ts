import { useCallback, useRef, useState } from "react"
import { toast } from "sonner"

/**
 * Wraps an async control action with a PER-INSTANCE pending flag, so a control can
 * disable itself and show an in-place spinner until its OWN action settles. There is
 * no shared/global busy state — sibling controls (a flip button, a device menu item,
 * a screen-share toggle) each track their own, so one in-flight action never disables
 * or spins the others. General across any async control (camera toggle, flip, device
 * switch, later screen-share). Re-entrancy is guarded synchronously (a ref) so a
 * second trigger can't stack while one is running. `errorMessage`, when set, surfaces
 * a toast on rejection; success stays silent (INV-63). The latest `action` closure is
 * always invoked (a ref), so callers can pass an inline closure over fresh state.
 */
export function useAsyncAction(
  action: () => Promise<unknown> | unknown,
  opts?: { errorMessage?: string }
): { pending: boolean; run: () => void } {
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const actionRef = useRef(action)
  actionRef.current = action
  const errorMessage = opts?.errorMessage

  const run = useCallback(() => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    Promise.resolve()
      .then(() => actionRef.current())
      .catch(() => {
        if (errorMessage) toast.error(errorMessage)
      })
      .finally(() => {
        pendingRef.current = false
        setPending(false)
      })
  }, [errorMessage])

  return { pending, run }
}
