import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocAwarenessPayload } from "@threahq/types"
import { DocPresence, PRESENCE_SEND_DEBOUNCE_MS, type PresenceUser } from "./doc-presence"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_doc"
const ME: PresenceUser = { userId: "usr_me", name: "Me", color: "#2563eb" }
const ALICE: PresenceUser = { userId: "usr_alice", name: "Alice", color: "#d97706" }

const cleanups: Array<() => void> = []

function createPresence() {
  const sent: DocAwarenessPayload[] = []
  const presence = new DocPresence({
    ydoc: new Y.Doc(),
    workspaceId: WORKSPACE_ID,
    docId: DOC_ID,
    send: (payload) => sent.push(payload),
  })
  cleanups.push(() => presence.destroy())
  return { presence, sent }
}

function createAwareness(): Awareness {
  const awareness = new Awareness(new Y.Doc())
  cleanups.push(() => awareness.destroy())
  return awareness
}

/** A remote client's frame, as the server would relay it. */
function remoteFrame(user: PresenceUser, docId = DOC_ID): DocAwarenessPayload {
  const awareness = createAwareness()
  awareness.setLocalStateField("user", user)
  return {
    workspaceId: WORKSPACE_ID,
    docId,
    update: bytesToBase64(encodeAwarenessUpdate(awareness, [awareness.clientID])),
  }
}

function decodeInto(receiver: Awareness, frame: DocAwarenessPayload) {
  applyAwarenessUpdate(receiver, base64ToBytes(frame.update), "test")
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})

describe("DocPresence", () => {
  it("should send one frame carrying the local user when the debounce window ends", () => {
    const { presence, sent } = createPresence()

    presence.setLocalUser(ME)
    expect(sent).toEqual([])
    vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)

    const receiver = createAwareness()
    for (const frame of sent) decodeInto(receiver, frame)
    expect({
      frames: sent.map(({ workspaceId, docId }) => ({ workspaceId, docId })),
      state: receiver.getStates().get(presence.awareness.clientID),
    }).toEqual({
      frames: [{ workspaceId: WORKSPACE_ID, docId: DOC_ID }],
      state: { user: ME },
    })
  })

  it("should coalesce changes into one frame with the latest state when they land inside the window", () => {
    const { presence, sent } = createPresence()

    presence.setLocalUser(ME)
    presence.awareness.setLocalStateField("cursor", { anchor: 1, head: 1 })
    presence.awareness.setLocalStateField("cursor", { anchor: 2, head: 3 })
    vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)

    const receiver = createAwareness()
    for (const frame of sent) decodeInto(receiver, frame)
    expect({ count: sent.length, state: receiver.getStates().get(presence.awareness.clientID) }).toEqual({
      count: 1,
      state: { user: ME, cursor: { anchor: 2, head: 3 } },
    })
  })

  it("should send nothing when the local state has no user yet", () => {
    const { presence, sent } = createPresence()

    presence.awareness.setLocalStateField("cursor", { anchor: 1, head: 1 })
    vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)

    expect(sent).toEqual([])
  })

  it("should list one peer per user and never the local client when frames arrive for this doc", () => {
    const { presence, sent } = createPresence()
    presence.setLocalUser(ME)
    const listener = vi.fn()
    presence.subscribe(listener)

    presence.receive(remoteFrame({ userId: "usr_other", name: "Other", color: "#059669" }, "stream_elsewhere"))
    presence.receive({ ...remoteFrame(ALICE), workspaceId: "ws_elsewhere" })
    const ignored = presence.peers()
    presence.receive(remoteFrame(ALICE))
    presence.receive(remoteFrame(ALICE))
    vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)

    expect({
      ignored,
      peers: presence.peers(),
      stable: presence.peers() === presence.peers(),
      notified: listener.mock.calls.length > 0,
      echoed: sent.length,
    }).toEqual({ ignored: [], peers: [ALICE], stable: true, notified: true, echoed: 1 })
  })

  it("should send the removal synchronously when destroyed", () => {
    const { presence, sent } = createPresence()
    presence.setLocalUser(ME)
    vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)
    const receiver = createAwareness()
    decodeInto(receiver, sent[0])
    const clientId = presence.awareness.clientID

    presence.destroy()
    for (const frame of sent.slice(1)) decodeInto(receiver, frame)

    expect({ frames: sent.length, present: receiver.getStates().has(clientId) }).toEqual({ frames: 2, present: false })
  })

  it("should send the full local state immediately when resent", () => {
    const { presence, sent } = createPresence()
    presence.setLocalUser(ME)
    vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)

    presence.resend()

    const receiver = createAwareness()
    decodeInto(receiver, sent[1])
    expect({ frames: sent.length, state: receiver.getStates().get(presence.awareness.clientID) }).toEqual({
      frames: 2,
      state: { user: ME },
    })
  })
})
