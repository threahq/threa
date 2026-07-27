import { useEffect } from "react"
import { useStreamName } from "@/hooks/use-stream-name"
import { useCallManager } from "./call-manager-context"

/**
 * Push the call's stream label at the lock-screen media session. The manager
 * holds a `streamId`, and the single stream-name resolver is a hook — so the
 * resolved label is pushed in rather than pulled (frontend `CLAUDE.md`: one
 * resolver, no hand-rolled lookups).
 */
export function useCallMediaSessionTitle(workspaceId: string | null, streamId: string | null): void {
  const manager = useCallManager()
  const name = useStreamName(workspaceId ?? "", streamId ?? "", "generic")
  useEffect(() => {
    if (!name) return
    manager.setCallTitle(name)
  }, [manager, name])
}
