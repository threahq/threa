import { useActiveCall } from "@/stores/active-calls-store"
import { useWorkspaceUserId } from "@/hooks/use-workspaces"
import { useCallId } from "./call-store-hooks"

/**
 * True when the viewer already holds this call somewhere that isn't this device:
 * the live roster still lists them (`participantUserIds`, kept fresh by
 * `call:participants_changed`), but no local session is on that call.
 *
 * Entry points read this BEFORE the user acts, so joining from a second device
 * offers "Take over" up front instead of a Join that fails with 409
 * `CALL_ENDPOINT_ACTIVE` and then asks for confirmation. The 409 prompt stays as
 * the fallback for what this can't see coming — a device that joined a moment
 * ago, or a roster this client hasn't received yet.
 *
 * Reads the stream-scoped roster: the workspace bootstrap seeds presence only
 * (`ActiveCall` carries no ids), so this is meaningful on a stream the viewer has
 * opened — which is where every entry point that consults it lives. Elsewhere it
 * answers false and the 409 prompt covers the case.
 *
 * Also true right after a reload of this same tab, where the "other device" is
 * the previous incarnation still holding an unlapsed lease. Taking over is the
 * right action there too, and the server resolves it as a rebind rather than a
 * takeover (a lapsed-socket endpoint is `reconnecting`, which rebinds first), so
 * the extra flag costs nothing.
 */
export function useCallOnAnotherDevice(workspaceId: string | undefined, callId: string | undefined): boolean {
  const live = useActiveCall(workspaceId, callId)
  const selfUserId = useWorkspaceUserId(workspaceId ?? "")
  const localCallId = useCallId()
  if (!live || !selfUserId || !callId) return false
  if (localCallId === callId) return false
  return live.participantUserIds.includes(selfUserId)
}
