import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness"
import { base64ToBytes, bytesToBase64 } from "@threahq/crypto"
import type { DocAwarenessPayload } from "@threahq/types"
import { getPresenceColor } from "@/lib/avatar-color"
import { DocPresence, PRESENCE_SEND_WINDOW_MS, type PresenceUser } from "./doc-presence"

const WORKSPACE_ID = "ws_1"
const DOC_ID = "stream_doc"
const ME = { userId: "usr_me", name: "Me" }
const ALICE = { userId: "usr_alice", name: "Alice" }
const BOB = { userId: "usr_bob", name: "Bob" }
const CARA = { userId: "usr_cara", name: "Cara" }

/** What a peer renders for a user: the colour always derives from the id. */
function seen(user: { userId: string; name: string }): PresenceUser {
  return { ...user, color: getPresenceColor(user.userId) }
}

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

/** A remote client's current state, as the server would relay it. */
function frameOf(awareness: Awareness, docId = DOC_ID): DocAwarenessPayload {
  return {
    workspaceId: WORKSPACE_ID,
    docId,
    update: bytesToBase64(encodeAwarenessUpdate(awareness, [awareness.clientID])),
  }
}

function remoteFrame(user: unknown, docId = DOC_ID): DocAwarenessPayload {
  const awareness = createAwareness()
  awareness.setLocalStateField("user", user)
  return frameOf(awareness, docId)
}

/** The local state a fresh peer holds for `presence` after receiving `frames`. */
function stateSeenByPeer(presence: DocPresence, frames: DocAwarenessPayload[]) {
  const peer = createAwareness()
  for (const frame of frames) applyAwarenessUpdate(peer, base64ToBytes(frame.update), "test")
  return peer.getStates().get(presence.awareness.clientID)
}

/** Clients in one doc room: every frame reaches every other member once `settle` runs. */
function createRoom() {
  const members: DocPresence[] = []
  const queue: Array<{ from: DocPresence; frame: DocAwarenessPayload }> = []
  const sentBy = new Map<DocPresence, number>()
  const join = (user: { userId: string; name: string }) => {
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
    members.push(presence)
    presence.setLocalUser(user)
    return presence
  }
  const settle = () => {
    for (let round = 0; round < 10; round++) {
      vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)
      if (queue.length === 0) return
      for (const { from, frame } of queue.splice(0))
        for (const member of members) if (member !== from) member.receive(frame)
    }
    throw new Error("presence never settled")
  }
  const dropInFlight = () => {
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)
    queue.splice(0)
  }
  const framesSent = () => members.map((member) => sentBy.get(member) ?? 0)
  return { members, join, settle, dropInFlight, framesSent, resetCounts: () => sentBy.clear() }
}

/** What y-protocols' 15 s renewal does; its clock is lib0's captured Date.now, which fake timers cannot move. */
function renew(presence: DocPresence) {
  presence.awareness.setLocalState(presence.awareness.getLocalState())
}

const peerIds = (presence: DocPresence) => presence.peers().map((peer) => peer.userId)

/** A caret in the shape y-prosemirror writes: both ends a Yjs relative position. */
function caret(clock: number) {
  const at = { item: { client: 1, clock }, assoc: 0 }
  return { anchor: at, head: at }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})

describe("DocPresence", () => {
  it("should send one frame carrying the local user when the send window ends", () => {
    const { presence, sent } = createPresence()

    presence.setLocalUser(ME)
    expect(sent).toEqual([])
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)

    expect({
      frames: sent.map(({ workspaceId, docId }) => ({ workspaceId, docId })),
      state: stateSeenByPeer(presence, sent),
    }).toEqual({
      frames: [{ workspaceId: WORKSPACE_ID, docId: DOC_ID }],
      state: { user: seen(ME) },
    })
  })

  it("should coalesce changes into one frame with the latest state when they land inside the window", () => {
    const { presence, sent } = createPresence()

    presence.setLocalUser(ME)
    presence.awareness.setLocalStateField("cursor", caret(1))
    presence.awareness.setLocalStateField("cursor", caret(2))
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)

    expect({ count: sent.length, state: stateSeenByPeer(presence, sent) }).toEqual({
      count: 1,
      state: { user: seen(ME), cursor: caret(2) },
    })
  })

  it("should send nothing when the local state has no user yet", () => {
    const { presence, sent } = createPresence()

    presence.awareness.setLocalStateField("cursor", caret(1))
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)

    expect(sent).toEqual([])
  })

  it("should ignore frames for another doc or workspace", () => {
    const { presence } = createPresence()
    presence.setLocalUser(ME)

    presence.receive(remoteFrame(BOB, "stream_elsewhere"))
    presence.receive({ ...remoteFrame(ALICE), workspaceId: "ws_elsewhere" })

    expect(presence.peers()).toEqual([])
  })

  it("should list one peer per user and never the local client when frames arrive for this doc", () => {
    const { presence } = createPresence()
    presence.setLocalUser(ME)
    const listener = vi.fn()
    presence.subscribe(listener)

    presence.receive(remoteFrame(ALICE))
    presence.receive(remoteFrame(ALICE))

    expect({
      peers: presence.peers(),
      stable: presence.peers() === presence.peers(),
      notified: listener.mock.calls.length > 0,
    }).toEqual({ peers: [seen(ALICE)], stable: true, notified: true })
  })

  it("should not list the viewer's own other tab", () => {
    const { presence } = createPresence()
    presence.setLocalUser(ME)

    presence.receive(remoteFrame(ME))
    presence.receive(remoteFrame(ALICE))

    expect(presence.peers()).toEqual([seen(ALICE)])
  })

  it("should colour a peer by its id, never by the wire colour", () => {
    const { presence } = createPresence()
    const alice = createAwareness()
    alice.setLocalStateField("user", { ...ALICE, color: "#000;background:url(https://x)" })

    presence.receive(frameOf(alice))

    expect({ peers: presence.peers(), caret: presence.awareness.getStates().get(alice.clientID) }).toEqual({
      peers: [seen(ALICE)],
      caret: { user: seen(ALICE), cursor: null },
    })
  })

  it("should drop a state whose user is malformed", () => {
    const { presence } = createPresence()
    presence.setLocalUser(ME)
    const badId = createAwareness()
    badId.setLocalState({ user: { userId: 1, name: "One" }, cursor: caret(1) })
    const notAnObject = createAwareness()
    notAnObject.setLocalState({ user: "x", cursor: caret(1) })

    presence.receive(frameOf(badId))
    presence.receive(frameOf(notAnObject))

    expect({
      peers: presence.peers(),
      badId: presence.awareness.getStates().has(badId.clientID),
      notAnObject: presence.awareness.getStates().has(notAnObject.clientID),
    }).toEqual({ peers: [], badId: false, notAnObject: false })
  })

  it("should keep a peer whose caret would not decode, without the caret", () => {
    const { presence } = createPresence()
    presence.setLocalUser(ME)
    const alice = createAwareness()
    const frames = [
      1,
      { anchor: {}, head: {} },
      { anchor: { item: { client: "x", clock: "y" } }, head: caret(1).head },
      { anchor: { item: { client: 1, clock: -1 } }, head: caret(1).head },
      { anchor: { item: { client: 1, clock: 0.5 } }, head: caret(1).head },
    ]

    const carets = frames.map((cursor) => {
      alice.setLocalState({ user: ALICE, cursor })
      presence.receive(frameOf(alice))
      return presence.awareness.getStates().get(alice.clientID)?.cursor
    })

    expect({ peers: presence.peers(), carets }).toEqual({
      peers: [seen(ALICE)],
      carets: [null, null, null, null, null],
    })
  })

  it("should ignore a frame sent under this client's id", () => {
    const { presence, sent } = createPresence()
    presence.setLocalUser(ME)
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)
    const forgedDoc = new Y.Doc()
    forgedDoc.clientID = presence.awareness.clientID
    const forged = new Awareness(forgedDoc)
    cleanups.push(() => forged.destroy())
    forged.setLocalState({ user: { userId: "usr_evil", name: "Evil" } })
    forged.setLocalState({ user: { userId: "usr_evil", name: "Evil" } })

    presence.receive(frameOf(forged))
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)

    expect({ local: presence.awareness.getLocalState(), frames: sent.length }).toEqual({
      local: { user: seen(ME) },
      frames: 1,
    })
  })

  it("should drop a frame that carries more than one client", () => {
    const { presence } = createPresence()
    presence.setLocalUser(ME)
    const alice = createAwareness()
    alice.setLocalStateField("user", ALICE)
    const bob = createAwareness()
    bob.setLocalStateField("user", BOB)
    applyAwarenessUpdate(alice, encodeAwarenessUpdate(bob, [bob.clientID]), "test")

    presence.receive({
      workspaceId: WORKSPACE_ID,
      docId: DOC_ID,
      update: bytesToBase64(encodeAwarenessUpdate(alice, [alice.clientID, bob.clientID])),
    })

    expect(presence.peers()).toEqual([])
  })

  it("should keep the peers reference when only a caret moved", () => {
    const { presence } = createPresence()
    presence.setLocalUser(ME)
    const alice = createAwareness()
    alice.setLocalStateField("user", ALICE)
    presence.receive(frameOf(alice))
    const before = presence.peers()
    const listener = vi.fn()
    presence.subscribe(listener)

    alice.setLocalStateField("cursor", caret(3))
    presence.receive(frameOf(alice))

    expect({ same: presence.peers() === before, notified: listener.mock.calls.length }).toEqual({
      same: true,
      notified: 0,
    })
  })

  it("should re-announce the local user once when a new peer appears, not when a known peer changes", () => {
    const { presence, sent } = createPresence()
    presence.setLocalUser(ME)
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)
    const alice = createAwareness()

    alice.setLocalStateField("user", ALICE)
    presence.receive(frameOf(alice))
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)
    alice.setLocalStateField("cursor", caret(1))
    presence.receive(frameOf(alice))
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)

    expect({ frames: sent.length, state: stateSeenByPeer(presence, sent) }).toEqual({
      frames: 2,
      state: { user: seen(ME) },
    })
  })

  it("should send the removal synchronously when destroyed", () => {
    const { presence, sent } = createPresence()
    presence.setLocalUser(ME)
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)

    presence.destroy()

    expect({ frames: sent.length, state: stateSeenByPeer(presence, sent) }).toEqual({ frames: 2, state: undefined })
  })

  it("should send the full local state immediately when resent", () => {
    const { presence, sent } = createPresence()
    presence.setLocalUser(ME)
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)

    presence.resend()

    expect({ frames: sent.length, state: stateSeenByPeer(presence, sent.slice(1)) }).toEqual({
      frames: 2,
      state: { user: seen(ME) },
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

    expect(presence.peers()).toEqual([seen(ALICE)])
  })

  it("should withdraw the local client at once and reappear with the same state when restored", () => {
    const { presence, sent } = createPresence()
    presence.setLocalUser(ME)
    presence.awareness.setLocalStateField("cursor", caret(4))
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)

    presence.withdraw()
    const afterWithdraw = stateSeenByPeer(presence, sent)
    presence.restore()
    vi.advanceTimersByTime(PRESENCE_SEND_WINDOW_MS)

    expect({ afterWithdraw, afterRestore: stateSeenByPeer(presence, sent) }).toEqual({
      afterWithdraw: undefined,
      afterRestore: { user: seen(ME), cursor: caret(4) },
    })
  })

  it("should restore the viewer to peers after withdraw", () => {
    const room = createRoom()
    const viewer = room.join(ME)
    room.settle()
    const alice = room.join(ALICE)
    room.settle()

    viewer.withdraw()
    room.settle()
    const whileWithdrawn = peerIds(alice)
    room.resetCounts()
    viewer.restore()
    room.settle()

    expect({ whileWithdrawn, alice: peerIds(alice), viewer: peerIds(viewer), framesSent: room.framesSent() }).toEqual({
      whileWithdrawn: [],
      alice: [ME.userId],
      viewer: [ALICE.userId],
      framesSent: [1, 1],
    })
  })

  it("should relearn a peer that timed out when it re-announces", () => {
    const room = createRoom()
    const a = room.join(ALICE)
    room.settle()
    const b = room.join(BOB)
    room.settle()

    removeAwarenessStates(a.awareness, [b.awareness.clientID], "timeout")
    removeAwarenessStates(b.awareness, [a.awareness.clientID], "timeout")
    room.dropInFlight()
    const whileTimedOut = { a: peerIds(a), b: peerIds(b) }
    b.resend()
    room.settle()

    expect({ whileTimedOut, a: peerIds(a), b: peerIds(b) }).toEqual({
      whileTimedOut: { a: [], b: [] },
      a: [BOB.userId],
      b: [ALICE.userId],
    })
  })

  it("should converge in one round and stay quiet on renewals when a newcomer joins three peers", () => {
    const room = createRoom()
    for (const user of [ALICE, BOB, CARA]) {
      room.join(user)
      room.settle()
    }
    room.resetCounts()

    room.join(ME)
    room.settle()
    const joinFrames = room.framesSent()
    const converged = room.members.map((member) => peerIds(member).sort())
    room.resetCounts()

    for (const member of room.members) renew(member)
    room.settle()

    expect({ joinFrames, converged, renewalFrames: room.framesSent() }).toEqual({
      joinFrames: [1, 1, 1, 2],
      converged: [
        ["usr_bob", "usr_cara", "usr_me"],
        ["usr_alice", "usr_cara", "usr_me"],
        ["usr_alice", "usr_bob", "usr_me"],
        ["usr_alice", "usr_bob", "usr_cara"],
      ],
      renewalFrames: [1, 1, 1, 1],
    })
  })
})
