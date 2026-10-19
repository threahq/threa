import { toast } from "sonner"
import { ShareErrorCodes } from "@threahq/types"
import { ApiError } from "@/api/client"

export const SHARE_PRIVACY_WARNING_MESSAGE = "This share would expose the source to people outside the source stream."

export function isPrivacyConfirmationError(err: unknown): err is ApiError {
  return ApiError.isApiError(err) && err.status === 409 && err.code === ShareErrorCodes.PRIVACY_CONFIRMATION_REQUIRED
}

/**
 * The 409 asked for consent to send content the composer still holds. The
 * owner dismisses it (returned cleanup) once that content changes, so the
 * confirmation can never cover anything the author did not see it for.
 */
export function surfacePrivacyConfirmToast(
  id: string,
  { confirmLabel, onConfirm, onCancel }: { confirmLabel: string; onConfirm: () => void; onCancel: () => void }
): () => void {
  toast.warning(SHARE_PRIVACY_WARNING_MESSAGE, {
    id,
    duration: Infinity,
    action: { label: confirmLabel, onClick: onConfirm },
    cancel: { label: "Cancel", onClick: onCancel },
  })
  return () => toast.dismiss(id)
}

/**
 * Surfaced when the message queue receives 409 +
 * `SHARE_PRIVACY_CONFIRMATION_REQUIRED` for a pending share — the user has
 * not acknowledged that the share exposes its source to people outside
 * the source stream. Two paths:
 *
 * - **Share anyway** — re-enqueue with `confirmedPrivacyWarning: true` and
 *   clear the `blocked-privacy` status so the queue's next drain
 *   re-attempts with the confirmation flag forwarded to the API.
 * - **Cancel** — drop the pending row and its optimistic event so the
 *   half-failed share disappears cleanly.
 *
 * State writes go through `usePendingMessages` (`retryMessage` /
 * `deleteMessage`) rather than touching `db.*` directly so we don't
 * bypass the React state cleanup the context performs.
 */
export interface SharePrivacyToastDeps {
  retryMessage: (id: string, patch?: Record<string, unknown>) => Promise<void>
  deleteMessage: (id: string) => Promise<void>
}

export function surfacePrivacyBlockToast(clientMessageId: string, deps: SharePrivacyToastDeps): void {
  const id = `share-privacy-${clientMessageId}`
  toast.warning(SHARE_PRIVACY_WARNING_MESSAGE, {
    id,
    duration: Infinity,
    action: {
      label: "Share anyway",
      onClick: async () => {
        await deps.retryMessage(clientMessageId, { confirmedPrivacyWarning: true, status: undefined })
        toast.dismiss(id)
      },
    },
    cancel: {
      label: "Cancel",
      onClick: async () => {
        await deps.deleteMessage(clientMessageId)
        toast.dismiss(id)
      },
    },
  })
}
