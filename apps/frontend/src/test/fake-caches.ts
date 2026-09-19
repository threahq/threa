/** In-memory CacheStorage double — jsdom ships none, and both SW stashes need one. */
class FakeCache {
  private readonly entries = new Map<string, Response>()

  async put(request: string, response: Response): Promise<void> {
    this.entries.set(request, response)
  }

  async match(request: string): Promise<Response | undefined> {
    return this.entries.get(request)?.clone()
  }

  async delete(request: string): Promise<boolean> {
    return this.entries.delete(request)
  }
}

/** Install `globalThis.caches` for this test; pair with {@link uninstallFakeCaches}. */
export function installFakeCaches(): void {
  const caches_ = new Map<string, FakeCache>()
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
}

export function uninstallFakeCaches(): void {
  Reflect.deleteProperty(globalThis, "caches")
}
