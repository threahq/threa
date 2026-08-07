import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { TokenStore } from "./token-store"

let dir: string

type Child = {
  exitCode: number | null
  exited: Promise<number>
  kill(signal?: NodeJS.Signals): void
  stderrText: Promise<string>
  stdoutText: Promise<string>
}

const children = new Set<Child>()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "threa-token-store-"))
})

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  await Promise.all([...children].map((child) => child.exited))
  children.clear()
  rmSync(dir, { recursive: true, force: true })
})

test("set persists a token that a fresh store instance loads back", () => {
  const path = join(dir, "state.json")
  new TokenStore(path).set("ws_1", "dlg_1", "tok_a")

  expect(new TokenStore(path).get("ws_1", "dlg_1")).toBe("tok_a")
})

test("get returns undefined for an unknown workspace or delegation, and when no file exists", () => {
  const store = new TokenStore(join(dir, "missing.json"))
  expect(store.get("ws_1", "dlg_1")).toBeUndefined()

  store.set("ws_1", "dlg_1", "tok_a")
  expect(store.get("ws_2", "dlg_1")).toBeUndefined()
  expect(store.get("ws_1", "dlg_2")).toBeUndefined()
})

test("an already-loaded store observes another store creating the shared state file", () => {
  const path = join(dir, "state.json")
  const sharedHead = new TokenStore(path)
  expect(sharedHead.get("ws_1", "dlg_1")).toBeUndefined()

  new TokenStore(path).set("ws_1", "dlg_1", "tok_new")

  expect(sharedHead.get("ws_1", "dlg_1")).toBe("tok_new")
})

test("an already-loaded store observes another store replacing a shared claim token", () => {
  const path = join(dir, "state.json")
  const sharedHead = new TokenStore(path)
  sharedHead.set("ws_1", "dlg_1", "tok_old")
  expect(sharedHead.get("ws_1", "dlg_1")).toBe("tok_old")

  new TokenStore(path).set("ws_1", "dlg_1", "tok_new")

  expect(sharedHead.get("ws_1", "dlg_1")).toBe("tok_new")
})

test("delete clears one token and prunes an emptied workspace, leaving siblings intact", () => {
  const path = join(dir, "state.json")
  const store = new TokenStore(path)
  store.set("ws_1", "dlg_1", "tok_a")
  store.set("ws_1", "dlg_2", "tok_b")
  store.set("ws_2", "dlg_9", "tok_c")

  store.delete("ws_1", "dlg_1")
  expect(new TokenStore(path).get("ws_1", "dlg_1")).toBeUndefined()
  expect(new TokenStore(path).get("ws_1", "dlg_2")).toBe("tok_b")

  store.delete("ws_1", "dlg_2")
  const state = JSON.parse(readFileSync(path, "utf8")) as { claimTokens: Record<string, unknown> }
  expect(state.claimTokens.ws_1).toBeUndefined()
  expect(state.claimTokens.ws_2).toEqual({ dlg_9: "tok_c" })
})

test("deleteIfMatches preserves a replacement token", () => {
  const path = join(dir, "state.json")
  const store = new TokenStore(path)
  store.set("ws_1", "dlg_1", "tok_old")
  store.set("ws_1", "dlg_1", "tok_new")

  expect(store.deleteIfMatches("ws_1", "dlg_1", "tok_old")).toBe(false)
  expect(store.get("ws_1", "dlg_1")).toBe("tok_new")
  expect(store.deleteIfMatches("ws_1", "dlg_1", "tok_new")).toBe(true)
  expect(store.get("ws_1", "dlg_1")).toBeUndefined()
})

test("deleteIfMatches reloads under lock so another store's replacement survives", () => {
  const path = join(dir, "state.json")
  const releasingStore = new TokenStore(path)
  releasingStore.set("ws_1", "dlg_1", "tok_old")
  expect(releasingStore.get("ws_1", "dlg_1")).toBe("tok_old")

  new TokenStore(path).set("ws_1", "dlg_1", "tok_new")

  expect(releasingStore.deleteIfMatches("ws_1", "dlg_1", "tok_old")).toBe(false)
  expect(new TokenStore(path).get("ws_1", "dlg_1")).toBe("tok_new")
})

test("an explicit old token compare-delete cannot remove another store's replacement", () => {
  const path = join(dir, "state.json")
  const releaseStore = new TokenStore(path)
  new TokenStore(path).set("ws_1", "dlg_1", "tok_new")

  expect(releaseStore.deleteIfMatches("ws_1", "dlg_1", "tok_explicit_old")).toBe(false)
  expect(new TokenStore(path).get("ws_1", "dlg_1")).toBe("tok_new")
})

test("mutations from stale store instances preserve unrelated tokens", () => {
  const path = join(dir, "state.json")
  const first = new TokenStore(path)
  const second = new TokenStore(path)
  first.set("ws_1", "dlg_1", "tok_a")
  second.set("ws_1", "dlg_2", "tok_b")
  first.set("ws_2", "dlg_3", "tok_c")

  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    claimTokens: { ws_1: { dlg_1: "tok_a", dlg_2: "tok_b" }, ws_2: { dlg_3: "tok_c" } },
  })
})

const moduleUrl = pathToFileURL(join(import.meta.dir, "token-store.ts")).href

async function waitForFile(path: string, child: Child): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!existsSync(path)) {
    if (child.exitCode !== null) {
      throw new Error(`child exited before creating ${path}: ${await child.stderrText}`)
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`)
    await Bun.sleep(5)
  }
}

function spawnChild(args: string[]): Child {
  const process = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const child: Child = {
    get exitCode() {
      return process.exitCode
    },
    exited: process.exited,
    kill: (signal) => process.kill(signal),
    stderrText: new Response(process.stderr).text(),
    stdoutText: new Response(process.stdout).text(),
  }
  children.add(child)
  return child
}

function spawnHolder(path: string, ready: string): Child {
  return spawnChild([
    process.execPath,
    "-e",
    `import { writeFileSync } from "node:fs";
       import { TokenStore } from ${JSON.stringify(moduleUrl)};
       const [path, ready] = process.argv.slice(1);
       const unlock = new TokenStore(path).lock();
       writeFileSync(ready, "");
       while (!(await Bun.file(ready + ".release").exists())) await Bun.sleep(5);
       unlock();`,
    path,
    ready,
  ])
}

function spawnSet(path: string, delegationId: string, token: string): Child {
  return spawnChild([
    process.execPath,
    "-e",
    `import { TokenStore } from ${JSON.stringify(moduleUrl)};
       const [path, delegationId, token] = process.argv.slice(1);
       new TokenStore(path).set("ws_1", delegationId, token);`,
    path,
    delegationId,
    token,
  ])
}

function spawnTimedSet(path: string): Child {
  return spawnChild([
    process.execPath,
    "-e",
    `import { TokenStore } from ${JSON.stringify(moduleUrl)};
     const started = Date.now();
     try {
       new TokenStore(process.argv[1]).set("ws_1", "dlg_timeout", "tok_timeout");
     } catch {
       console.log(Date.now() - started);
       process.exit(1);
     }`,
    path,
  ])
}

test("a healthy owner releases immediately for another process", async () => {
  const path = join(dir, "state.json")
  const unlock = (new TokenStore(path) as unknown as { lock(): () => void }).lock()
  expect(statSync(`${path}.lock.sqlite`).mode & 0o777).toBe(0o600)
  unlock()

  const child = spawnSet(path, "dlg_1", "tok_1")
  await child.exited
  expect(child.exitCode).toBe(0)
  expect(new TokenStore(path).get("ws_1", "dlg_1")).toBe("tok_1")
})

test("a child transaction blocks another mutation until release", async () => {
  const path = join(dir, "state.json")
  const ready = join(dir, "owner-ready")
  const owner = spawnHolder(path, ready)
  try {
    await waitForFile(ready, owner)
    const waiter = spawnSet(path, "dlg_1", "tok_1")
    await Bun.sleep(100)
    expect(waiter.exitCode).toBeNull()

    writeFileSync(`${ready}.release`, "")
    await Promise.all([owner.exited, waiter.exited])
    expect(waiter.exitCode).toBe(0)
    expect(new TokenStore(path).get("ws_1", "dlg_1")).toBe("tok_1")
  } finally {
    if (owner.exitCode === null) owner.kill("SIGKILL")
    await owner.exited
  }
})

test("killing a holder releases the OS lock and concurrent recoverers preserve every token", async () => {
  const path = join(dir, "state.json")
  const ready = join(dir, "owner-ready")
  const owner = spawnHolder(path, ready)
  const recoverers: Child[] = []
  try {
    await waitForFile(ready, owner)
    owner.kill("SIGKILL")
    await owner.exited

    recoverers.push(...Array.from({ length: 4 }, (_, index) => spawnSet(path, `dlg_${index}`, `tok_${index}`)))
    await Promise.all(recoverers.map((child) => child.exited))
    expect(recoverers.map((child) => child.exitCode)).toEqual([0, 0, 0, 0])
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      claimTokens: { ws_1: { dlg_0: "tok_0", dlg_1: "tok_1", dlg_2: "tok_2", dlg_3: "tok_3" } },
    })
  } finally {
    for (const child of [owner, ...recoverers]) {
      if (child.exitCode === null) child.kill("SIGKILL")
    }
    await Promise.all([owner, ...recoverers].map((child) => child.exited))
  }
}, 10_000)

test("compare-delete reloads a child-process replacement under the lock", async () => {
  const path = join(dir, "state.json")
  const stale = new TokenStore(path)
  stale.set("ws_1", "dlg_1", "tok_old")

  const replacement = spawnSet(path, "dlg_1", "tok_new")
  await replacement.exited
  expect(replacement.exitCode).toBe(0)
  expect(stale.deleteIfMatches("ws_1", "dlg_1", "tok_old")).toBe(false)
  expect(new TokenStore(path).get("ws_1", "dlg_1")).toBe("tok_new")
})

test("lock timeout is bounded and the failed acquisition closes cleanly", async () => {
  const path = join(dir, "state.json")
  const ready = join(dir, "owner-ready")
  const owner = spawnHolder(path, ready)
  try {
    await waitForFile(ready, owner)
    const timedOut = spawnTimedSet(path)
    await timedOut.exited
    const elapsed = Number(await timedOut.stdoutText)
    expect(timedOut.exitCode).not.toBe(0)
    expect(elapsed).toBeGreaterThanOrEqual(4_000)
    expect(elapsed).toBeLessThan(8_000)

    writeFileSync(`${ready}.release`, "")
    await owner.exited
    new TokenStore(path).set("ws_1", "dlg_after", "tok_after")
    expect(new TokenStore(path).get("ws_1", "dlg_after")).toBe("tok_after")
  } finally {
    if (owner.exitCode === null) owner.kill("SIGKILL")
    await owner.exited
  }
}, 20_000)

test("a later set overwrites the token for the same key", () => {
  const path = join(dir, "state.json")
  new TokenStore(path).set("ws_1", "dlg_1", "tok_a")
  new TokenStore(path).set("ws_1", "dlg_1", "tok_b")

  expect(new TokenStore(path).get("ws_1", "dlg_1")).toBe("tok_b")
})

test("a corrupt state file warns once on stderr and starts empty rather than throwing", () => {
  const path = join(dir, "state.json")
  writeFileSync(path, "{ not json")
  const warn = spyOn(process.stderr, "write").mockImplementation(() => true)

  try {
    const store = new TokenStore(path)
    expect(store.get("ws_1", "dlg_1")).toBeUndefined()
    expect(store.get("ws_1", "dlg_2")).toBeUndefined()
    const warnings = warn.mock.calls.filter((c) => String(c[0]).includes("corrupt"))
    expect(warnings.length).toBe(1)
  } finally {
    warn.mockRestore()
  }
})

test("a healthy read followed by external corruption warns exactly once across refreshed gets", () => {
  const path = join(dir, "state.json")
  new TokenStore(path).set("ws_1", "dlg_1", "tok_a")
  const store = new TokenStore(path)
  expect(store.get("ws_1", "dlg_1")).toBe("tok_a")
  const warn = spyOn(process.stderr, "write").mockImplementation(() => true)

  try {
    writeFileSync(path, "{ not json")
    expect(store.get("ws_1", "dlg_1")).toBeUndefined()
    expect(store.get("ws_1", "dlg_1")).toBeUndefined()
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("corrupt")).length).toBe(1)
  } finally {
    warn.mockRestore()
  }
})

test("a missing read does not consume the warning before later corruption", () => {
  const path = join(dir, "state.json")
  const store = new TokenStore(path)
  const warn = spyOn(process.stderr, "write").mockImplementation(() => true)

  try {
    expect(store.get("ws_1", "dlg_1")).toBeUndefined()
    writeFileSync(path, "{ not json")
    expect(store.get("ws_1", "dlg_1")).toBeUndefined()
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("corrupt")).length).toBe(1)
  } finally {
    warn.mockRestore()
  }
})

test("mutation reloads warn once for corruption and continue persisting tokens", () => {
  const path = join(dir, "state.json")
  const store = new TokenStore(path)
  const warn = spyOn(process.stderr, "write").mockImplementation(() => true)

  try {
    writeFileSync(path, "{ first corruption")
    store.set("ws_1", "dlg_1", "tok_a")
    writeFileSync(path, "{ second corruption")
    store.set("ws_1", "dlg_2", "tok_b")
    expect(warn.mock.calls.filter((call) => String(call[0]).includes("corrupt")).length).toBe(1)
    expect(store.get("ws_1", "dlg_2")).toBe("tok_b")
  } finally {
    warn.mockRestore()
  }
})

test("a missing file loads silently with no stderr warning", () => {
  const warn = spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    new TokenStore(join(dir, "nope.json")).get("ws_1", "dlg_1")
    expect(warn.mock.calls.length).toBe(0)
  } finally {
    warn.mockRestore()
  }
})

test("the persisted file is written with 0600 permissions", () => {
  const path = join(dir, "state.json")
  new TokenStore(path).set("ws_1", "dlg_1", "tok_a")

  expect(existsSync(path)).toBe(true)
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test("THREA_STATE_FILE overrides the default path when no constructor arg is given", () => {
  const path = join(dir, "env-state.json")
  const prev = process.env.THREA_STATE_FILE
  process.env.THREA_STATE_FILE = path
  try {
    new TokenStore().set("ws_1", "dlg_1", "tok_env")
    expect(existsSync(path)).toBe(true)
    expect(new TokenStore().get("ws_1", "dlg_1")).toBe("tok_env")
  } finally {
    if (prev === undefined) delete process.env.THREA_STATE_FILE
    else process.env.THREA_STATE_FILE = prev
  }
})
