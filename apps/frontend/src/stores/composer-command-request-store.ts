import { getActiveDb } from "@/db"
import { createDbScopedRegistry } from "@/lib/db-scoped-registry"

const HANDOFF_TTL_MS = 30 * 1000

interface CommandEntry {
  request: { command: string; expiresAt: number } | null
  listeners: Set<() => void>
}

const entries = createDbScopedRegistry<CommandEntry>()
const createEntry = (): CommandEntry => ({ request: null, listeners: new Set() })

export function queueComposerCommandRequest(streamId: string, command: string): void {
  const { entry } = entries.acquire(streamId, createEntry)
  entry.request = { command, expiresAt: Date.now() + HANDOFF_TTL_MS }
  for (const listener of entry.listeners) listener()
}

export function consumeComposerCommandRequest(streamId: string): string | null {
  const entry = entries.peek(streamId)
  if (!entry?.request) return null
  const request = entry.request
  entry.request = null
  if (entry.listeners.size === 0) entries.remove(getActiveDb(), streamId, entry)
  return request.expiresAt >= Date.now() ? request.command : null
}

export function subscribeComposerCommandRequest(streamId: string, listener: () => void): () => void {
  const { database, entry } = entries.acquire(streamId, createEntry)
  entry.listeners.add(listener)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size === 0 && (!entry.request || entry.request.expiresAt < Date.now())) {
      entries.remove(database, streamId, entry)
    }
  }
}
