import type * as Y from "yjs"
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocAwarenessPayload } from "@threahq/types"
import { REMOTE_ORIGIN } from "./doc-sync"

export const PRESENCE_SEND_DEBOUNCE_MS = 50

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

/** One doc session's awareness (who is here, where their caret is), relayed over the socket and never stored. */
export class DocPresence {
  readonly awareness: Awareness
  private readonly workspaceId: string
  private readonly docId: string
  private readonly send: (payload: DocAwarenessPayload) => void
  private sendTimer: ReturnType<typeof setTimeout> | null = null
  private peersSnapshot: PresenceUser[] | null = null
  private stateBeforeLeave: Record<string, unknown> | null = null

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
    this.awareness.on("change", () => {
      this.peersSnapshot = null
    })
    this.awareness.on("update", this.onUpdate)
  }

  setLocalUser(user: PresenceUser | null): void {
    this.awareness.setLocalStateField("user", user)
  }

  receive = (payload: DocAwarenessPayload): void => {
    if (payload.workspaceId !== this.workspaceId || payload.docId !== this.docId) return
    try {
      applyAwarenessUpdate(this.awareness, base64ToBytes(payload.update), REMOTE_ORIGIN)
    } catch {
      // Any peer can put bytes on this channel; a frame that does not decode is dropped, never thrown into the socket listener.
    }
  }

  /** Withdraws the local client from peers (the page is going away or into the back-forward cache) without ending the session. */
  leave = (): void => {
    const state = this.awareness.getLocalState()
    if (!state) return
    this.stateBeforeLeave = state
    this.awareness.setLocalState(null)
  }

  /** Re-announces the state `leave` withdrew; a no-op unless the client left. */
  rejoin = (): void => {
    const state = this.stateBeforeLeave
    if (!state) return
    this.stateBeforeLeave = null
    this.awareness.setLocalState(state)
  }

  resend(): void {
    this.clearSendTimer()
    this.sendLocalState()
  }

  peers = (): PresenceUser[] => {
    if (this.peersSnapshot) return this.peersSnapshot
    const byUserId = new Map<string, PresenceUser>()
    for (const [clientId, state] of this.awareness.getStates()) {
      const user = (state as { user?: PresenceUser | null }).user
      if (clientId === this.awareness.clientID || !user || byUserId.has(user.userId)) continue
      byUserId.set(user.userId, user)
    }
    this.peersSnapshot = [...byUserId.values()]
    return this.peersSnapshot
  }

  subscribe = (listener: () => void): (() => void) => {
    this.awareness.on("change", listener)
    return () => this.awareness.off("change", listener)
  }

  destroy(): void {
    this.clearSendTimer()
    this.awareness.destroy()
  }

  private onUpdate = ({ added, updated, removed }: AwarenessChange, origin: unknown): void => {
    const local = this.awareness.clientID
    if (origin === REMOTE_ORIGIN) {
      // A newcomer has none of our state until our next change; known peers are never re-added, so this settles.
      if (added.length > 0) this.scheduleSend()
      return
    }
    if (removed.includes(local)) {
      this.clearSendTimer()
      this.sendLocalState()
      return
    }
    if (added.includes(local) || updated.includes(local)) this.scheduleSend()
  }

  private scheduleSend(): void {
    this.sendTimer ??= setTimeout(() => {
      this.sendTimer = null
      this.sendLocalState()
    }, PRESENCE_SEND_DEBOUNCE_MS)
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
