const HANDOFF_TTL_MS = 30 * 1000

const requests = new Map<string, { command: string; expiresAt: number }>()
const listeners = new Map<string, Set<() => void>>()

export function queueComposerCommandRequest(streamId: string, command: string): void {
  requests.set(streamId, { command, expiresAt: Date.now() + HANDOFF_TTL_MS })
  for (const listener of listeners.get(streamId) ?? []) listener()
}

export function consumeComposerCommandRequest(streamId: string): string | null {
  const request = requests.get(streamId)
  if (!request) return null
  requests.delete(streamId)
  return request.expiresAt >= Date.now() ? request.command : null
}

export function subscribeComposerCommandRequest(streamId: string, listener: () => void): () => void {
  let streamListeners = listeners.get(streamId)
  if (!streamListeners) {
    streamListeners = new Set()
    listeners.set(streamId, streamListeners)
  }
  streamListeners.add(listener)
  return () => {
    streamListeners.delete(listener)
    if (streamListeners.size === 0) listeners.delete(streamId)
  }
}
