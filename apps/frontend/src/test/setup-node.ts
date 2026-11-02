import { vi } from "vitest"

// Files share a worker's module cache and globals (`isolate: false`); this runs
// before every test file and drops what the previous file left installed.
vi.unstubAllGlobals()
vi.unstubAllEnvs()
vi.useRealTimers()
