import { useEffect } from "react"
import { useSearchParams } from "react-router-dom"
import { toast } from "sonner"
import { NOTIFICATION_ACTION_FAILED_PARAM, describeNotificationActionFailure } from "@/lib/sw-notification-format"

/**
 * A notification action button that failed opens the app with the reason in
 * `?notify_failed=`; show it once and restore the canonical URL. Owned here so
 * the warm path (the worker navigates an open window) and the cold open land
 * on one reader.
 */
export function useNotificationActionFailure(): void {
  const [searchParams, setSearchParams] = useSearchParams()
  const failure = searchParams.get(NOTIFICATION_ACTION_FAILED_PARAM)
  useEffect(() => {
    if (failure === null) return
    const message = describeNotificationActionFailure(failure)
    if (message) toast.error(message)
    setSearchParams(
      (prev) => {
        prev.delete(NOTIFICATION_ACTION_FAILED_PARAM)
        return prev
      },
      { replace: true }
    )
  }, [failure, setSearchParams])
}
