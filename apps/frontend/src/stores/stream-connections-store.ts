import { useCallback, useEffect, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { StreamConnectionErrorCodes, type StreamConnection } from "@threahq/types"
import { ApiError } from "@/api/client"
import { streamConnectionsApi } from "@/api/stream-connections"
import { useSocketReconnectCount } from "@/contexts"
import { db, type CachedStreamConnection } from "@/db"

/**
 * A channel's Connect rows, read live from IDB. The tab's fetch seeds them and
 * `stream_connection:updated` keeps them current, so a partner accepting in
 * another workspace shows without a refetch. Newest first, undefined until IDB answers.
 */
export function useStreamConnections(workspaceId: string, streamId: string): CachedStreamConnection[] | undefined {
  return useLiveQuery(
    () => db.streamConnections.where("[workspaceId+streamId]").equals([workspaceId, streamId]).reverse().toArray(),
    [workspaceId, streamId]
  )
}

/**
 * Writes one row unless IDB already holds its revision or a newer one: the
 * create response, the socket event and a fetch can land in any order.
 */
export async function putStreamConnection(workspaceId: string, connection: StreamConnection): Promise<void> {
  await db.transaction("rw", db.streamConnections, async () => {
    const current = await db.streamConnections.get([workspaceId, connection.id])
    if (current && current.revision >= connection.revision) return
    await db.streamConnections.put({ ...connection, workspaceId, _cachedAt: Date.now() })
  })
}

/**
 * Replaces a channel's rows with a fetch's answer, which lists only active and
 * pending ones. A row it leaves out was revoked, expired or moved on while no
 * event reached this device, so it goes, unless it was written after the fetch
 * started and the answer predates it.
 */
export async function seedStreamConnections(
  workspaceId: string,
  streamId: string,
  connections: StreamConnection[],
  fetchStartedAt: number
): Promise<void> {
  await db.transaction("rw", db.streamConnections, async () => {
    const current = await db.streamConnections.where("[workspaceId+streamId]").equals([workspaceId, streamId]).toArray()
    const fetchedIds = new Set(connections.map((c) => c.id))
    const stale = current.filter((row) => !fetchedIds.has(row.id) && row._cachedAt < fetchStartedAt)
    await db.streamConnections.bulkDelete(stale.map((row): [string, string] => [workspaceId, row.id]))

    const revisions = new Map(current.map((row) => [row.id, row.revision]))
    const cachedAt = Date.now()
    const newer = connections.filter((c) => (revisions.get(c.id) ?? 0) < c.revision)
    await db.streamConnections.bulkPut(newer.map((c) => ({ ...c, workspaceId, _cachedAt: cachedAt })))
  })
}

/** Fetches a channel's rows and seeds IDB with them. */
export async function refreshStreamConnections(workspaceId: string, streamId: string): Promise<void> {
  const startedAt = Date.now()
  const connections = await streamConnectionsApi.list(workspaceId, streamId)
  await seedStreamConnections(workspaceId, streamId, connections, startedAt)
}

/**
 * Mints an invite link. The plaintext token exists only in this answer, so it
 * goes to `keepToken` before this device writes the row. The socket event can
 * still land first, showing the row a moment before its link.
 */
export async function createStreamConnectionInvite(
  workspaceId: string,
  streamId: string,
  keepToken: (connectionId: string, token: string) => void
): Promise<void> {
  const { connection, token } = await streamConnectionsApi.createInvite(workspaceId, streamId)
  keepToken(connection.id, token)
  await putStreamConnection(workspaceId, connection)
}

/**
 * Revokes a pending link. A refusal because it was accepted or is gone means
 * this device missed that change, so the rows are refetched before the refusal
 * reaches the caller.
 */
export async function revokeStreamConnection(workspaceId: string, streamId: string, connectionId: string) {
  try {
    await putStreamConnection(workspaceId, await streamConnectionsApi.revoke(workspaceId, connectionId))
  } catch (error) {
    if (isStaleRow(error)) await refreshStreamConnections(workspaceId, streamId).catch(() => undefined)
    throw error
  }
}

function isStaleRow(error: unknown): boolean {
  return (
    ApiError.isApiError(error) &&
    (error.code === StreamConnectionErrorCodes.ALREADY_ACCEPTED || error.code === StreamConnectionErrorCodes.NOT_FOUND)
  )
}

export type StreamConnectionsLoad = "loading" | "loaded" | "failed"

/**
 * Fetches a channel's rows into IDB on mount and again after every socket
 * reconnect, since catch-up after a long gap bootstraps without replaying
 * these events (INV-53). A reconnect refetch keeps the current status, so the
 * tab doesn't drop back to its skeleton.
 */
export function useLoadStreamConnections(
  workspaceId: string,
  streamId: string
): { status: StreamConnectionsLoad; retry: () => void } {
  const reconnectCount = useSocketReconnectCount()
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<{ key: string; status: "loaded" | "failed" } | null>(null)
  const key = `${workspaceId}/${streamId}/${attempt}`

  useEffect(() => {
    let cancelled = false
    refreshStreamConnections(workspaceId, streamId).then(
      () => !cancelled && setSettled({ key, status: "loaded" }),
      () => !cancelled && setSettled({ key, status: "failed" })
    )
    return () => {
      cancelled = true
    }
  }, [workspaceId, streamId, key, reconnectCount])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { status: settled?.key === key ? settled.status : "loading", retry }
}
