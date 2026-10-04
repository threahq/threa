import { StreamErrorCodes, StreamReadOnlyReasons } from "@threahq/types"
import { ApiError } from "@/api"

export const GUEST_DM_CLOSED_REASON = "Workspace settings close direct messages with guests."

export const GUEST_DM_READ_ONLY_REASON = `${GUEST_DM_CLOSED_REASON} It can be read but not posted to.`

/** The backend's refusal of a DM the guest DM policy closes, for a pair the client still thought open. */
export function isGuestDmPolicyError(error: unknown): boolean {
  return (
    ApiError.isApiError(error) &&
    error.status === 403 &&
    error.code === StreamErrorCodes.READ_ONLY &&
    error.details?.reason === StreamReadOnlyReasons.GUEST_DM_POLICY
  )
}
