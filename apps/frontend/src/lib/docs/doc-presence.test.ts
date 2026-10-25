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

  it("should re-announce the local user once when a new peer appears, not when a known peer changes", () => {
    const { presence, sent } = createPresence()
    presence.setLocalUser(ME)
    vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)
    const alice = createAwareness()
    const aliceFrame = () => ({
      workspaceId: WORKSPACE_ID,
      docId: DOC_ID,
      update: bytesToBase64(encodeAwarenessUpdate(alice, [alice.clientID])),
    })

    alice.setLocalStateField("user", ALICE)
    presence.receive(aliceFrame())
    vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)
    alice.setLocalStateField("cursor", { anchor: 1, head: 1 })
    presence.receive(aliceFrame())
    vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)

    const receiver = createAwareness()
    decodeInto(receiver, sent[1])
    expect({ frames: sent.length, state: receiver.getStates().get(presence.awareness.clientID) }).toEqual({
      frames: 2,
      state: { user: ME },
    })
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
  it("should drop a frame without throwing when its update is not a decodable awareness frame", () => {
    const { presence } = createPresence()
    presence.setLocalUser(ME)

    const receiveGarbage = () => {
      presence.receive({ workspaceId: WORKSPACE_ID, docId: DOC_ID, update: "%%% not base64 %%%" })
      presence.receive({ workspaceId: WORKSPACE_ID, docId: DOC_ID, update: bytesToBase64(new Uint8Array([5, 1])) })
    }
    expect(receiveGarbage).not.toThrow()
    presence.receive(remoteFrame(ALICE))

    expect(presence.peers()).toEqual([ALICE])
  })

  it("should withdraw the local client at once when leaving and reappear with the same state when rejoining", () => {
    const { presence, sent } = createPresence()
    presence.setLocalUser(ME)
    presence.awareness.setLocalStateField("cursor", { anchor: 4, head: 4 })
    vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)
    const receiver = createAwareness()
    const clientId = presence.awareness.clientID
    const deliver = () => {
      for (const frame of sent.splice(0)) decodeInto(receiver, frame)
    }
    deliver()

    presence.leave()
    deliver()
    const afterLeave = receiver.getStates().get(clientId) ?? null
    presence.rejoin()
    vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)
    deliver()

    expect({ afterLeave, afterRejoin: receiver.getStates().get(clientId) }).toEqual({
      afterLeave: null,
      afterRejoin: { user: ME, cursor: { anchor: 4, head: 4 } },
    })
  })

  it("should converge in one round and stay quiet on renewals when a newcomer joins three peers", () => {
    const room: DocPresence[] = []
    const queue: Array<{ from: DocPresence; frame: DocAwarenessPayload }> = []
    const sentBy = new Map<DocPresence, number>()
    const join = (user: PresenceUser) => {
      const presence: DocPresence = new DocPresence({
        ydoc: new Y.Doc(),
        workspaceId: WORKSPACE_ID,
        docId: DOC_ID,
        send: (frame) => {
          sentBy.set(presence, (sentBy.get(presence) ?? 0) + 1)
          queue.push({ from: presence, frame })
        },
      })
      cleanups.push(() => presence.destroy())
      room.push(presence)
      presence.setLocalUser(user)
      return presence
    }
    const settle = () => {
      for (let round = 0; round < 10; round++) {
        vi.advanceTimersByTime(PRESENCE_SEND_DEBOUNCE_MS)
        if (queue.length === 0) return
        for (const { from, frame } of queue.splice(0))
          for (const member of room) if (member !== from) member.receive(frame)
      }
      throw new Error("presence never settled")
    }
    const users: PresenceUser[] = [
      ALICE,
      { userId: "usr_bob", name: "Bob", color: "#059669" },
      { userId: "usr_cara", name: "Cara", color: "#7c3aed" },
    ]
    for (const user of users) {
      join(user)
      settle()
    }
    sentBy.clear()

    join(ME)
    settle()
    const joinFrames = room.map((member) => sentBy.get(member) ?? 0)
    const converged = room.map((member) =>
      member
        .peers()
        .map((peer) => peer.userId)
        .sort()
    )
    sentBy.clear()

    // What y-protocols' 15 s renewal does; its clock is lib0's captured Date.now, which fake timers cannot move.
    for (const member of room) member.awareness.setLocalState(member.awareness.getLocalState())
    settle()

    const everyone = [...users, ME].map((user) => user.userId)
    expect({
      joinFrames,
      converged,
      renewalFrames: room.map((member) => sentBy.get(member) ?? 0),
    }).toEqual({
      joinFrames: [1, 1, 1, 2],
      converged: everyone.map((_, i) => everyone.filter((__, j) => j !== i).sort()),
      renewalFrames: [1, 1, 1, 1],
    })
  })
})
