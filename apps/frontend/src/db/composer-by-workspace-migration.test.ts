import { describe, it, expect } from "vitest"
import Dexie from "dexie"
import { withoutWorkspace } from "@/test/workspace-rows"
import { ThreaDatabase, type ComposerLoaded, type ComposerTarget } from "./database"

const V34_COMPOSER_LOADED = "scope, workspaceId"
const V48_COMPOSER_TARGET = "host, workspaceId"

const LEGACY_STORES = ["composerLoaded", "composerTarget"]

function loadedPointer(scope: string, workspaceId: string, draftId: string | null): ComposerLoaded {
  return { scope, workspaceId, draftId }
}

function target(host: string, workspaceId: string, scope: string): ComposerTarget {
  return { host, workspaceId, scope }
}

async function seedV54(name: string, seed: (legacy: Dexie) => Promise<void>): Promise<void> {
  const legacy = new Dexie(name)
  legacy.version(54).stores({ composerLoaded: V34_COMPOSER_LOADED, composerTarget: V48_COMPOSER_TARGET })
  await legacy.open()
  await seed(legacy)
  legacy.close()
}

describe("v55 composer pointers keyed by workspace", () => {
  it("should carry rows that name a workspace to the new keys and drop the rest when upgrading from v54", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const pointerA = loadedPointer("stream:stream_a", "ws_1", "draft_a")
    const pointerB = loadedPointer("thread:msg_b", "ws_2", null)
    const pointerOrphan = loadedPointer("stream:stream_orphan", "ws_1", "draft_orphan")
    const targetA = target("stream:stream_a", "ws_1", "board:reply:conv_a")
    const targetB = target("stream:stream_b", "ws_2", "board:reply:conv_b")
    const targetOrphan = target("stream:stream_orphan", "ws_1", "board:reply:conv_orphan")

    await seedV54(name, async (legacy) => {
      await legacy.table("composerLoaded").bulkPut([pointerB, withoutWorkspace(pointerOrphan), pointerA])
      await legacy.table("composerTarget").bulkPut([targetB, withoutWorkspace(targetOrphan), targetA])
    })

    const db = new ThreaDatabase(name)
    await db.open()

    expect({
      pointers: await db.composerLoaded.toArray(),
      pointerByKey: await db.composerLoaded.get(["ws_2", "thread:msg_b"]),
      pointersInWorkspace: await db.composerLoaded.where("workspaceId").equals("ws_1").toArray(),
      pointerOrphan: await db.composerLoaded.get(["ws_1", "stream:stream_orphan"]),

      targets: await db.composerTarget.toArray(),
      targetByKey: await db.composerTarget.get(["ws_2", "stream:stream_b"]),
      targetsInWorkspace: await db.composerTarget.where("workspaceId").equals("ws_1").toArray(),
      targetOrphan: await db.composerTarget.get(["ws_1", "stream:stream_orphan"]),

      legacyStores: db.tables.map((table) => table.name).filter((tableName) => LEGACY_STORES.includes(tableName)),
    }).toEqual({
      pointers: [pointerA, pointerB],
      pointerByKey: pointerB,
      pointersInWorkspace: [pointerA],
      pointerOrphan: undefined,

      targets: [targetA, targetB],
      targetByKey: targetB,
      targetsInWorkspace: [targetA],
      targetOrphan: undefined,

      legacyStores: [],
    })

    db.close()
    await Dexie.delete(name)
  })

  it("should hold the same scope and the same host independently per workspace when written after the upgrade", async () => {
    const name = `threa_test_${Math.random().toString(36).slice(2)}`
    const pointerA = loadedPointer("stream:stream_copied", "ws_a", "draft_a")
    const pointerB = loadedPointer("stream:stream_copied", "ws_b", "draft_b")
    const targetA = target("stream:stream_copied", "ws_a", "board:reply:conv_a")
    const targetB = target("stream:stream_copied", "ws_b", "board:reply:conv_b")

    await seedV54(name, async (legacy) => {
      await legacy.table("composerLoaded").put(pointerA)
      await legacy.table("composerTarget").put(targetA)
    })

    const db = new ThreaDatabase(name)
    await db.open()
    await db.composerLoaded.put(pointerB)
    await db.composerTarget.put(targetB)

    const both = {
      pointers: await db.composerLoaded.toArray(),
      targets: await db.composerTarget.toArray(),
    }

    await db.composerLoaded.delete(["ws_a", "stream:stream_copied"])
    await db.composerTarget.delete(["ws_a", "stream:stream_copied"])

    expect({
      both,
      afterDeletingA: {
        pointers: await db.composerLoaded.toArray(),
        targets: await db.composerTarget.toArray(),
      },
    }).toEqual({
      both: { pointers: [pointerA, pointerB], targets: [targetA, targetB] },
      afterDeletingA: { pointers: [pointerB], targets: [targetB] },
    })

    db.close()
    await Dexie.delete(name)
  })
})
