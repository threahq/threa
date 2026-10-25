import type * as Y from "yjs"
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, modifyAwarenessUpdate } from "y-protocols/awareness"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocAwarenessPayload } from "@threahq/types"
import { getPresenceColor } from "@/lib/avatar-color"

export const PRESENCE_SEND_WINDOW_MS = 50

export interface PresenceUser {
  userId: string
  name: string
  /** `#rrggbb` */
  color: string
}

interface AwarenessChange {
  added: number[]
  updated: number[]
  removed: number[]
}

/**
 * The wire colour is never trusted (y-prosemirror's caret builders put it in inline styles), and a state without a
 * valid user is treated as absent (y-prosemirror would render it as "User: <clientId>").
 */
function sanitizeState(state: unknown): Record<string, unknown> | null {
  if (typeof state !== "object" || state === null) return null
  const user = (state as { user?: unknown }).user
  if (typeof user !== "object" || user === null) return null
  const { userId, name } = user as { userId?: unknown; name?: unknown }
  if (typeof userId !== "string" || typeof name !== "string") return null
  return { ...state, user: { userId, name, color: getPresenceColor(userId) } }
}

function samePeers(a: PresenceUser[], b: PresenceUser[]): boolean {
  return (
    a.length === b.length &&
    a.every((peer, i) => peer.userId === b[i].userId && peer.name === b[i].name && peer.color === b[i].color)
  )
}

/** One doc session's awareness (who is here, where their caret is), relayed over the socket and never stored. */
export class DocPresence {
  readonly awareness: Awareness
  private readonly workspaceId: string
  private readonly docId: string
  private readonly send: (payload: DocAwarenessPayload) => void
  private readonly listeners = new Set<() => void>()
  private sendTimer: ReturnType<typeof setTimeout> | null = null
  private peersSnapshot: PresenceUser[] | null = null
  private stateBeforeWithdraw: Record<string, unknown> | null = null

  constructor(params: {
    ydoc: Y.Doc
    workspaceId: string
    docId: string
    send: (payload: DocAwarenessPayload) => void
  }) {
    this.workspaceId = params.workspaceId
    this.docId = params.docId
    this.send = params.send
    this.awareness = new Awareness(params.ydoc)
    this.awareness.on("change", this.onChange)
    this.awareness.on("update", this.onUpdate)
  }

  setLocalUser(user: { userId: string; name: string } | null): void {
    this.awareness.setLocalStateField("user", user && { ...user, color: getPresenceColor(user.userId) })
  }

  receive = (payload: DocAwarenessPayload): void => {
    if (payload.workspaceId !== this.workspaceId || payload.docId !== this.docId) return
    const known = new Set(this.awareness.getStates().keys())
    try {
      applyAwarenessUpdate(this.awareness, modifyAwarenessUpdate(base64ToBytes(payload.update), sanitizeState), this)
    } catch {
      // Any peer can put bytes on this channel; a frame that does not decode is dropped, never thrown into the socket listener.
      return
    }
    // A newcomer, or a peer that timed us out or withdrew, has none of our state until our next change.
    if ([...this.awareness.getStates().keys()].some((clientId) => !known.has(clientId))) this.announce()
  }

  /** Withdraws the local client from peers (the page is going away or into the back-forward cache) without ending the session. */
  withdraw = (): void => {
    const state = this.awareness.getLocalState()
    if (!state) return
    this.stateBeforeWithdraw = state
    this.awareness.setLocalState(null)
  }

  /** Re-announces the state `withdraw` removed; a no-op unless the client withdrew. */
  restore = (): void => {
    const state = this.stateBeforeWithdraw
    if (!state) return
    this.stateBeforeWithdraw = null
    this.awareness.setLocalState(state)
  }

  resend(): void {
    this.announce()
    this.sendNow()
  }

  peers = (): PresenceUser[] => {
    this.peersSnapshot ??= this.computePeers()
    return this.peersSnapshot
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  destroy(): void {
    this.clearSendTimer()
    this.listeners.clear()
    this.awareness.destroy()
  }

  private computePeers(): PresenceUser[] {
    const local = this.awareness.clientID
    const localUserId = (this.awareness.getLocalState()?.user as PresenceUser | null | undefined)?.userId
    const byUserId = new Map<string, PresenceUser>()
    for (const [clientId, state] of this.awareness.getStates()) {
      const user = (state as { user?: PresenceUser | null }).user
      if (clientId === local || !user || user.userId === localUserId || byUserId.has(user.userId)) continue
      byUserId.set(user.userId, user)
    }
    return [...byUserId.values()]
  }

  private onChange = (): void => {
    const next = this.computePeers()
    if (this.peersSnapshot && samePeers(this.peersSnapshot, next)) return
    this.peersSnapshot = next
    for (const listener of this.listeners) listener()
  }

  private onUpdate = ({ added, updated, removed }: AwarenessChange): void => {
    const local = this.awareness.clientID
    if (removed.includes(local)) return this.sendNow()
    if (added.includes(local) || updated.includes(local)) this.scheduleSend()
  }

  /** A peer that timed us out ignores a frame whose clock it has already seen, so every re-announce takes a fresh one. */
  private announce(): void {
    const state = this.awareness.getLocalState()
    if (state) this.awareness.setLocalState(state)
  }

  private scheduleSend(): void {
    this.sendTimer ??= setTimeout(() => {
      this.sendTimer = null
      this.sendLocalState()
    }, PRESENCE_SEND_WINDOW_MS)
  }

  private sendNow(): void {
    this.clearSendTimer()
    this.sendLocalState()
  }

  private sendLocalState(): void {
    const state = this.awareness.getLocalState()
    // A caret without a user would render as an anonymous "User: <clientId>" on peers.
    if (state && !state.user) return
    this.send({
      workspaceId: this.workspaceId,
      docId: this.docId,
      update: bytesToBase64(encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])),
    })
  }

  private clearSendTimer(): void {
    if (this.sendTimer) clearTimeout(this.sendTimer)
    this.sendTimer = null
  }
}
