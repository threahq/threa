import { useLiveQuery } from "dexie-react-hooks"
import { db } from "@/db"

/**
 * The durable, device-local answer to "which draft scope does this composer host
 * write into?". A host composes its own scope until something points it
 * elsewhere — today only "Reply in conversation", which points the timeline's
 * `stream:<S>` host at `board:reply:<C>`. Persisted, so the arm survives a
 * reload: the arm is not a flag hovering over whatever gets typed next, it IS
 * which draft is being edited.
 */
export async function setComposerTarget(workspaceId: string, host: string, scope: string): Promise<void> {
  await db.composerTarget.put({ host, workspaceId, scope })
}

export async function clearComposerTarget(host: string): Promise<void> {
  await db.composerTarget.delete(host)
}

export interface ComposerTargetState {
  /** The stored target scope for this host, or null when the host composes its own scope. */
  scope: string | null
  /** False until the IDB read for THIS host has settled — callers hold the host scope meanwhile. */
  isResolved: boolean
}

const UNRESOLVED: ComposerTargetState = { scope: null, isResolved: false }

/**
 * The target row for `host`. The host is carried through the query result and
 * compared on read, so a stream switch can never render the previous stream's
 * target for the frame before the new subscription emits.
 */
export function useComposerTarget(host: string): ComposerTargetState {
  const row = useLiveQuery(async () => ({ host, scope: (await db.composerTarget.get(host))?.scope ?? null }), [host])
  if (!row || row.host !== host) return UNRESOLVED
  return { scope: row.scope, isResolved: true }
}
