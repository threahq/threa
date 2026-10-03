import { getActiveDb } from "@/db"
import { createDbScopedRegistry } from "@/lib/db-scoped-registry"
import { workspaceScopedKey } from "@/lib/workspace-scoped-key"

const HANDOFF_TTL_MS = 30 * 1000

interface CommandEntry {
  request: { command: string; expiresAt: number } | null
  listeners: Set<() => void>
}

const entries = createDbScopedRegistry<CommandEntry>()
const createEntry = (): CommandEntry => ({ request: null, listeners: new Set() })

export function queueComposerCommandRequest(workspaceId: string, streamId: string, command: string): void {
  const { entry } = entries.acquire(workspaceScopedKey(workspaceId, streamId), createEntry)
  entry.request = { command, expiresAt: Date.now() + HANDOFF_TTL_MS }
  for (const listener of entry.listeners) listener()
}

export function consumeComposerCommandRequest(workspaceId: string, streamId: string): string | null {
  const key = workspaceScopedKey(workspaceId, streamId)
  const entry = entries.peek(key)
  if (!entry?.request) return null
  const request = entry.request
  entry.request = null
  if (entry.listeners.size === 0) entries.remove(getActiveDb(), key, entry)
  return request.expiresAt >= Date.now() ? request.command : null
}

export function subscribeComposerCommandRequest(
  workspaceId: string,
  streamId: string,
  listener: () => void
): () => void {
  const key = workspaceScopedKey(workspaceId, streamId)
  const { database, entry } = entries.acquire(key, createEntry)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size === 0 && (!entry.request || entry.request.expiresAt < Date.now())) {
      entries.remove(database, key, entry)
    }
  }
}
