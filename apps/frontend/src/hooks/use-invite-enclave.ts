import { useCallback, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { Stream, StreamWithPreview, WorkspaceBootstrap } from "@threa/types"
import { db } from "@/db"
import { enclaveApi } from "@/api/enclave"
import { workspaceKeys } from "@/hooks/use-workspaces"
import { streamKeys } from "@/hooks/use-streams"

/**
 * Invite the enclave agent (Ariadne) into an existing E2E scratchpad. After
 * the call resolves, subsequent sends will fan their envelopes out to the live
 * enclave EIK set in addition to the owner's UIK (see `use-stream-or-draft`).
 *
 * Mirrors the cache-write pattern used by `useCreateEncryptedScratchpad`: the
 * workspace-bootstrap cache, the stream-detail cache, and the IDB row are all
 * patched in the same beat so the sidebar/header flip to "invited" without
 * waiting for the next bootstrap.
 */
export function useInviteEnclave(workspaceId: string, streamId: string) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(false)

  const invite = useCallback(async (): Promise<void> => {
    setPending(true)
    try {
      const updated = await enclaveApi.invite(workspaceId, streamId)

      queryClient.setQueryData<WorkspaceBootstrap>(workspaceKeys.bootstrap(workspaceId), (old) => {
        if (!old) return old
        const next: StreamWithPreview[] = (old.streams ?? []).map((s) => (s.id === streamId ? { ...s, ...updated } : s))
        return { ...old, streams: next }
      })

      queryClient.setQueryData<Stream | undefined>(streamKeys.detail(workspaceId, streamId), (old) =>
        old ? { ...old, ...updated } : updated
      )

      await db.streams.update(streamId, {
        e2eInvitedAgentKind: updated.e2eInvitedAgentKind,
        _cachedAt: Date.now(),
      })
    } finally {
      setPending(false)
    }
  }, [workspaceId, streamId, queryClient])

  return { invite, pending }
}

/**
 * UI gate for the "Invite Ariadne" button. True when the stream is an E2E
 * scratchpad with no agent currently invited — once the owner clicks invite,
 * `e2eInvitedAgentKind` flips to `"enclave"` and the button disappears.
 */
export function canInviteEnclave(
  stream: { e2eEnabled?: boolean; e2eInvitedAgentKind?: string | null } | undefined
): boolean {
  if (!stream) return false
  if (stream.e2eEnabled !== true) return false
  return stream.e2eInvitedAgentKind == null || stream.e2eInvitedAgentKind === "none"
}

/**
 * UI marker for the "Ariadne is here" indicator (sidebar badge, header chip).
 * True when the enclave has been invited; per-message recipients fan out to
 * the live EIK set on send.
 */
export function isEnclaveInvited(stream: { e2eInvitedAgentKind?: string | null } | undefined): boolean {
  return stream?.e2eInvitedAgentKind === "enclave"
}
