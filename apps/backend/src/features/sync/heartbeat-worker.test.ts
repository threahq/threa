import { afterEach, describe, expect, it, spyOn, mock } from "bun:test"
import type { Pool } from "pg"
import type { Server } from "socket.io"
import { SyncHeartbeatWorker } from "./heartbeat-worker"
import { SyncLogRepository } from "./repository"

function makeIo(rooms: string[]) {
  const emits: Array<{ room: string; eventType: string; payload: unknown }> = []
  const io = {
    sockets: { adapter: { rooms: new Map(rooms.map((room) => [room, new Set(["sock_1"])])) } },
    local: {
      to: (room: string) => ({
        emit: (eventType: string, payload: unknown) => {
          emits.push({ room, eventType, payload })
        },
      }),
    },
  }
  return { io: io as unknown as Server, emits }
}

describe("SyncHeartbeatWorker.tickOnce", () => {
  afterEach(() => {
    mock.restore()
  })

  it("emits each workspace's head to its bare workspace room via the local operator", async () => {
    const getHeads = spyOn(SyncLogRepository, "getHeads").mockResolvedValue(new Map([["workspace_a", 7n]]))
    const { io, emits } = makeIo([
      "ws:workspace_a",
      "ws:workspace_a:stream:stream_1",
      "ws:workspace_a:user:usr_1",
      "socket_id_room",
      "ws:workspace_b",
    ])
    const worker = new SyncHeartbeatWorker({ pool: {} as Pool, io })

    await worker.tickOnce()

    // Subrooms and socket-id rooms are excluded from the head query; a
    // workspace with no log entries reports head 0.
    expect(getHeads.mock.calls[0][1]).toEqual(["workspace_a", "workspace_b"])
    expect(emits).toEqual([
      {
        room: "ws:workspace_a",
        eventType: "sync:heartbeat",
        payload: { workspaceId: "workspace_a", head: "7" },
      },
      {
        room: "ws:workspace_b",
        eventType: "sync:heartbeat",
        payload: { workspaceId: "workspace_b", head: "0" },
      },
    ])
  })

  it("skips the head query entirely when no local workspace rooms exist", async () => {
    const getHeads = spyOn(SyncLogRepository, "getHeads")
    const { io, emits } = makeIo(["socket_id_room", "ws:workspace_a:stream:stream_1"])
    const worker = new SyncHeartbeatWorker({ pool: {} as Pool, io })

    await worker.tickOnce()

    expect(getHeads).not.toHaveBeenCalled()
    expect(emits).toEqual([])
  })

  it("survives a failing head query and emits nothing that tick", async () => {
    spyOn(SyncLogRepository, "getHeads").mockRejectedValue(new Error("db down"))
    const { io, emits } = makeIo(["ws:workspace_a"])
    const worker = new SyncHeartbeatWorker({ pool: {} as Pool, io })

    await worker.tickOnce()

    expect(emits).toEqual([])
  })
})
