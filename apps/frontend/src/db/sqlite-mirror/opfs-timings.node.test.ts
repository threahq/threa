import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { timeOpfsCalls, type OpfsApis } from "./opfs-timings"

const wait = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms))

function fakeOpfs(handleDelays: number[] = []) {
  let nextHandle = 0
  const directory = {
    getDirectoryHandle: () => wait(20, directory),
    getFileHandle: () => wait(1, file),
    removeEntry: () => wait(30, undefined),
    async *[Symbol.asyncIterator]() {
      for (const name of ["a", "b"]) yield await wait(10, [name, file] as const)
    },
  }
  const file = {
    createSyncAccessHandle: () => {
      const delay = handleDelays[nextHandle++]!
      return wait(delay, { delay })
    },
  }
  const storage = { getDirectory: () => wait(1, directory) }
  const syncHandle = {
    read: () => {
      vi.advanceTimersByTime(10)
      return 0
    },
    write: () => 0,
    flush: () => {},
    truncate: () => {},
    getSize: () => 0,
    close: () => {},
  }
  return { storage, directory, file, syncHandle } satisfies OpfsApis
}

// Mirrors the pool's install: probe file, directory walk, listing, then concurrent handles.
async function install({ storage, file, syncHandle }: ReturnType<typeof fakeOpfs>) {
  const root = await storage.getDirectory()
  await (await root.getFileHandle()).createSyncAccessHandle()
  await root.removeEntry()
  const dir = await root.getDirectoryHandle()
  const names: string[] = []
  for await (const [name] of dir) names.push(name)
  await Promise.all(names.map(() => file.createSyncAccessHandle()))
  syncHandle.read()
  return names
}

// A controlled clock: every duration below is exact.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "performance"] })
})

afterEach(() => {
  vi.useRealTimers()
})

async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync()
  return promise
}

describe("timeOpfsCalls", () => {
  it("reports how long each kind of OPFS call took during an install, then restores the APIs", async () => {
    const opfs = fakeOpfs([1, 5, 60])
    const originals = [
      opfs.storage.getDirectory,
      opfs.directory.getDirectoryHandle,
      opfs.directory.getFileHandle,
      opfs.directory.removeEntry,
      opfs.directory[Symbol.asyncIterator],
      opfs.file.createSyncAccessHandle,
      opfs.syncHandle.read,
    ]
    const { result, timings } = await settle(timeOpfsCalls(opfs, () => install(opfs)))

    expect(result).toEqual(["a", "b"])
    // The probe's 1ms handle and the concurrent 5ms and 60ms ones are pending for 61ms, not their 66ms sum.
    expect(timings).toEqual({
      handleCount: 3,
      handleMinMs: 1,
      handleMaxMs: 60,
      handleSpanMs: 131,
      opfsRootMs: 1,
      opfsDirMs: 20,
      opfsFileMs: 1,
      opfsRemoveMs: 30,
      opfsListMs: 20,
      opfsHandleMs: 61,
      opfsSyncIoMs: 10,
    })
    expect([
      opfs.storage.getDirectory,
      opfs.directory.getDirectoryHandle,
      opfs.directory.getFileHandle,
      opfs.directory.removeEntry,
      opfs.directory[Symbol.asyncIterator],
      opfs.file.createSyncAccessHandle,
      opfs.syncHandle.read,
    ]).toEqual(originals)
  })

  it("reports zeros for an install that makes no OPFS calls", async () => {
    const { timings } = await timeOpfsCalls(fakeOpfs(), async () => "cached pool")
    expect(timings).toEqual({
      handleCount: 0,
      handleMinMs: 0,
      handleMaxMs: 0,
      handleSpanMs: 0,
      opfsRootMs: 0,
      opfsDirMs: 0,
      opfsFileMs: 0,
      opfsRemoveMs: 0,
      opfsListMs: 0,
      opfsHandleMs: 0,
      opfsSyncIoMs: 0,
    })
  })

  it("restores the APIs when the install fails", async () => {
    const opfs = fakeOpfs([1])
    const original = opfs.file.createSyncAccessHandle
    const failed = timeOpfsCalls(opfs, async () => {
      await opfs.file.createSyncAccessHandle()
      throw new Error("locked")
    })
    await expect(settle(failed)).rejects.toThrow("locked")
    expect(opfs.file.createSyncAccessHandle).toBe(original)
  })
})
