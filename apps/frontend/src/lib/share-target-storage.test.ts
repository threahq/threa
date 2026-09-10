import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SHARE_TARGET_CACHE } from "./sw-messages"
import { clearShareStash, readShareStash, readShareStashFiles, stashShareTarget } from "./share-target-storage"

const OWNER_A = "user_01AAA"
const OWNER_B = "user_01BBB"

/** Minimal in-memory CacheStorage — jsdom ships none. */
class FakeCache {
  private readonly entries = new Map<string, Response>()

  async put(request: string, response: Response): Promise<void> {
    this.entries.set(request, response)
  }

  async match(request: string): Promise<Response | undefined> {
    return this.entries.get(request)?.clone()
  }

  async keys(): Promise<string[]> {
    return [...this.entries.keys()]
  }

  async delete(request: string): Promise<boolean> {
    return this.entries.delete(request)
  }
}

let caches_: Map<string, FakeCache>

beforeEach(() => {
  caches_ = new Map()
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async (name: string) => {
        let cache = caches_.get(name)
        if (!cache) {
          cache = new FakeCache()
          caches_.set(name, cache)
        }
        return cache
      },
      delete: async (name: string) => caches_.delete(name),
    },
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, "caches")
})

function share(owner: string | null, files: File[] = []) {
  return stashShareTarget({ title: "T", text: "body", url: "https://example.com", files, owner })
}

describe("share stash ownership", () => {
  it("reads back a stash for the account it was bound to", async () => {
    await share(OWNER_A, [new File(["png-bytes"], "shot.png", { type: "image/png" })])

    const read = await readShareStash(OWNER_A)
    expect(read).toEqual({
      kind: "shared",
      meta: { title: "T", text: "body", url: "https://example.com", hasFiles: true },
    })
    expect((await readShareStashFiles(OWNER_A)).map((f) => f.name)).toEqual(["shot.png"])
  })

  it("hides another account's stash and its files", async () => {
    await share(OWNER_A, [new File(["png-bytes"], "shot.png", { type: "image/png" })])

    expect(await readShareStash(OWNER_B)).toEqual({ kind: "none" })
    expect(await readShareStashFiles(OWNER_B)).toEqual([])
  })

  it("hides the stash from a tab with no resolved account", async () => {
    await share(OWNER_A)

    expect(await readShareStash(null)).toEqual({ kind: "none" })
    expect(await readShareStashFiles(null)).toEqual([])
  })

  it("keeps no content when the worker could not name an owner, and says so", async () => {
    await share(null, [new File(["png-bytes"], "shot.png", { type: "image/png" })])

    expect(await readShareStash(OWNER_A)).toEqual({ kind: "unclaimed" })
    expect(await readShareStashFiles(OWNER_A)).toEqual([])
    // The content itself was never written, so there is nothing for a later
    // account to find under the file keys either.
    const cache = await caches.open(SHARE_TARGET_CACHE)
    expect(await cache.match("/_share/file/0")).toBeUndefined()
  })

  it("never guesses an owner for a pre-marker stash", async () => {
    const cache = await caches.open(SHARE_TARGET_CACHE)
    await cache.put(
      "/_share/meta",
      new Response(JSON.stringify({ title: "legacy", text: null, url: null, fileCount: 1 }))
    )
    await cache.put("/_share/file/0", new Response("legacy-bytes"))

    expect(await readShareStash(OWNER_A)).toEqual({ kind: "none" })
    expect(await readShareStashFiles(OWNER_A)).toEqual([])
  })

  it("keeps an account's files when another account shares during its read", async () => {
    await share(OWNER_A, [new File(["a"], "a.png", { type: "image/png" })])

    const cache = await caches.open(`${SHARE_TARGET_CACHE}:${OWNER_A}`)
    const originalMatch = cache.match.bind(cache)
    let replaced = false
    cache.match = async (request: string) => {
      const response = await originalMatch(request)
      // The second share lands while the first file blob is being read.
      if (!replaced && request.includes("/_share/file/")) {
        replaced = true
        await share(OWNER_B, [new File(["b"], "b.png", { type: "image/png" })])
      }
      return response
    }

    expect((await readShareStashFiles(OWNER_A)).map((file) => file.name)).toEqual(["a.png"])
    expect((await readShareStashFiles(OWNER_B)).map((file) => file.name)).toEqual(["b.png"])
  })

  it("should keep concurrent shares and consumption scoped to their owners", async () => {
    await Promise.all([share(OWNER_A, [new File(["a"], "a.png")]), share(OWNER_B, [new File(["b"], "b.png")])])
    await clearShareStash(OWNER_B)
    expect((await readShareStashFiles(OWNER_A)).map((file) => file.name)).toEqual(["a.png"])
    expect(await readShareStash(OWNER_B)).toEqual({ kind: "none" })
  })

  it("replaces the previous stash rather than appending to it", async () => {
    await share(OWNER_A, [new File(["a"], "a.png"), new File(["b"], "b.png")])
    await share(OWNER_A, [new File(["c"], "c.png")])

    expect((await readShareStashFiles(OWNER_A)).map((f) => f.name)).toEqual(["c.png"])
  })

  it("clears the stash", async () => {
    await share(OWNER_A)
    await clearShareStash(OWNER_A)

    expect(await readShareStash(OWNER_A)).toEqual({ kind: "none" })
  })
})
