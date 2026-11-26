import { describe, expect, it } from "vitest"
import { timeOpfsCalls, type OpfsApis } from "./opfs-timings"

function busy(ms: number): number {
  const until = performance.now() + ms
  while (performance.now() < until);
  return 0
}

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
    read: () => busy(10),
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
    const { result, timings } = await timeOpfsCalls(opfs, () => install(opfs))

    expect(result).toEqual(["a", "b"])
    expect(timings.handleCount).toBe(3)
    expect(timings.handleMinMs).toBeLessThan(30)
    expect(timings.handleMaxMs).toBeGreaterThanOrEqual(55)
    expect(timings.handleSpanMs).toBeGreaterThanOrEqual(timings.handleMaxMs)
    // The probe's 1ms handle plus the two concurrent ones (5ms, 60ms) cover about 61ms, not their 66ms sum.
    expect(timings.opfsHandleMs).toBeGreaterThanOrEqual(timings.handleMaxMs)
    expect(timings.opfsHandleMs).toBeLessThan(timings.handleSpanMs)
    expect(timings.opfsSyncIoMs).toBeGreaterThanOrEqual(9)
    expect(timings.opfsDirMs).toBeGreaterThanOrEqual(15)
    expect(timings.opfsRemoveMs).toBeGreaterThanOrEqual(25)
    expect(timings.opfsListMs).toBeGreaterThanOrEqual(15)
    expect(timings.opfsRootMs).toBeLessThan(15)
    expect(timings.opfsFileMs).toBeLessThan(15)
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
    await expect(
      timeOpfsCalls(opfs, async () => {
        await opfs.file.createSyncAccessHandle()
        throw new Error("locked")
      })
    ).rejects.toThrow("locked")
    expect(opfs.file.createSyncAccessHandle).toBe(original)
  })
})
