import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  E2eKeyring,
  FileKeyStore,
  MacKeychainStore,
  SecretServiceStore,
  e2eKeyAccount,
  e2eStreamKeyAccount,
  e2eUserKeyAccount,
  readLegacyBikFile,
  resolveKeyStore,
  type CommandRunner,
  type E2eKeyRecord,
} from "./keyring"

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "threa-keyring-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
})

const RECORD: E2eKeyRecord = { keyId: "bik_1", publicKey: "pub", privateKey: "priv" }

function ok(stdout = ""): ReturnType<CommandRunner> {
  return { status: 0, stdout, stderr: "", unavailable: false }
}
const NOT_FOUND: ReturnType<CommandRunner> = { status: 44, stdout: "", stderr: "not found", unavailable: false }
const MISSING: ReturnType<CommandRunner> = { status: -1, stdout: "", stderr: "ENOENT", unavailable: true }

function secretOf(record: E2eKeyRecord): string {
  return Buffer.from(JSON.stringify(record), "utf8").toString("base64")
}

const ROTATED: E2eKeyRecord = { keyId: "bik_2", publicKey: "pub2", privateKey: "priv2" }

describe("e2eKeyAccount", () => {
  const base = { hostname: "box.local", instanceId: "inst/one", identitySeed: "bot_key_secret" }

  test("host is the default and every runtime on one box lands on it", () => {
    const account = e2eKeyAccount({ ...base, scope: "host" })
    expect(account).toBe(e2eKeyAccount({ ...base, scope: "host", instanceId: "inst/two" }))
    expect(account).toMatch(/^host-/)
  })

  test("the stream scope has no default account — every key is minted per stream", () => {
    expect(e2eKeyAccount({ ...base, scope: "stream" })).toBeNull()
    expect(e2eStreamKeyAccount("stream_a")).not.toBe(e2eStreamKeyAccount("stream_b"))
    expect(e2eStreamKeyAccount("stream_a")).toBe(e2eStreamKeyAccount("stream_a"))
  })

  test("a different host, identity, or instance is a different account", () => {
    const accounts = new Set([
      e2eKeyAccount({ ...base, scope: "host" }),
      e2eKeyAccount({ ...base, scope: "host", hostname: "other.local" }),
      e2eKeyAccount({ ...base, scope: "identity" }),
      e2eKeyAccount({ ...base, scope: "identity", identitySeed: "another_key" }),
      e2eKeyAccount({ ...base, scope: "instance" }),
      e2eKeyAccount({ ...base, scope: "instance", instanceId: "inst/two" }),
    ])
    expect(accounts.size).toBe(6)
  })

  test("no account leaks the secret it is derived from, or a path separator", () => {
    for (const scope of ["host", "identity", "instance"] as const) {
      const account = e2eKeyAccount({ ...base, scope })
      expect(account).not.toContain("bot_key_secret")
      expect(account).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })
})

describe("e2eUserKeyAccount", () => {
  test("a person's own key is filed per workspace and per user, never on a bot scope", () => {
    const base = { hostname: "box.local", instanceId: "inst/one", identitySeed: "bot_key_secret" }
    const mine = e2eUserKeyAccount("ws_1", "usr_1")

    expect(mine).toBe(e2eUserKeyAccount("ws_1", "usr_1"))
    expect(new Set([mine, e2eUserKeyAccount("ws_2", "usr_1"), e2eUserKeyAccount("ws_1", "usr_2")]).size).toBe(3)
    expect(mine).not.toBe(e2eKeyAccount({ ...base, scope: "host" }))
    expect(mine).toMatch(/^user-[0-9a-f]{16}$/)
  })
})

describe("resolveKeyStore", () => {
  test("an explicit file store is used even where a keychain works", () => {
    const store = resolveKeyStore({
      requested: "file",
      platform: "darwin",
      dir: tempDir(),
      hasExistingFileKey: false,
      exec: () => ok(),
    })
    expect(store.kind).toBe("file")
  })

  test("an explicit keychain that cannot run is an error, not a quiet move to disk", () => {
    expect(() =>
      resolveKeyStore({
        requested: "keychain",
        platform: "linux",
        dir: tempDir(),
        hasExistingFileKey: false,
        exec: () => MISSING,
      })
    ).toThrow("Secret Service unavailable")
  })

  test("with no choice, an existing file key keeps serving", () => {
    const store = resolveKeyStore({
      platform: "linux",
      dir: tempDir(),
      hasExistingFileKey: true,
      exec: () => {
        throw new Error("keychain must not be probed")
      },
    })
    expect(store.kind).toBe("file")
  })

  test("with no choice and no file key, a working keychain wins", () => {
    const store = resolveKeyStore({
      platform: "darwin",
      dir: tempDir(),
      hasExistingFileKey: false,
      exec: () => NOT_FOUND,
    })
    expect(store.kind).toBe("keychain")
  })

  test("with no choice, no file key, and no keychain, the operator is asked to pick one", () => {
    const dir = tempDir()
    let thrown: unknown
    try {
      resolveKeyStore({ platform: "linux", dir, hasExistingFileKey: false, exec: () => MISSING })
    } catch (error) {
      thrown = error
    }
    expect(String(thrown)).toContain('"keychain"')
    expect(String(thrown)).toContain(dir)
  })
})

describe("FileKeyStore", () => {
  test("write replaces a rotated key where createExclusive would keep the old one", () => {
    const store = new FileKeyStore({ dir: tempDir() })
    store.createExclusive("user-abc", RECORD)

    expect(store.createExclusive("user-abc", ROTATED)).toEqual(RECORD)
    store.write("user-abc", ROTATED)

    expect(store.read("user-abc")).toEqual(ROTATED)
  })

  test("a written key is readable only by its owner", () => {
    const dir = tempDir()
    new FileKeyStore({ dir }).write("user-abc", RECORD)

    expect(statSync(join(dir, "user-abc.json")).mode & 0o777).toBe(0o600)
  })

  test("remove forgets the account, and asking twice is not an error", () => {
    const store = new FileKeyStore({ dir: tempDir() })
    store.write("user-abc", RECORD)

    store.remove("user-abc")
    store.remove("user-abc")

    expect(store.read("user-abc")).toBeUndefined()
  })
})

describe("MacKeychainStore", () => {
  test("writes the secret on stdin, never in argv, and returns what the keychain then holds", () => {
    const calls: { args: string[]; input?: string }[] = []
    let held: string | undefined
    const exec: CommandRunner = (_command, args, input) => {
      calls.push({ args, ...(input === undefined ? {} : { input }) })
      if (args[0] === "-i") {
        held = secretOf(RECORD)
        return ok()
      }
      return held ? ok(`${held}\n`) : NOT_FOUND
    }
    const store = new MacKeychainStore({ exec })

    expect(store.read("host-abc")).toBeUndefined()
    expect(store.createExclusive("host-abc", RECORD)).toEqual(RECORD)
    const write = calls.find((call) => call.args[0] === "-i")!
    expect(write.args).toEqual(["-i"])
    expect(write.input).toContain(secretOf(RECORD))
  })

  test("a keychain that cannot be reached throws instead of reporting an empty account", () => {
    const store = new MacKeychainStore({ exec: () => MISSING })
    expect(() => store.read("host-abc")).toThrow("macOS keychain unavailable")
  })

  test("write updates an account the keychain already holds, with the secret still on stdin", () => {
    let held: string | undefined = secretOf(RECORD)
    let update: string | undefined
    const exec: CommandRunner = (_command, args, input) => {
      if (args[0] === "-i") {
        // Without `-U` the real tool refuses an account that already exists.
        if (!input?.includes(" -U ")) return { status: 45, stdout: "", stderr: "already exists", unavailable: false }
        update = input
        held = secretOf(ROTATED)
        return ok()
      }
      return held ? ok(`${held}\n`) : NOT_FOUND
    }
    const store = new MacKeychainStore({ exec })

    store.write("user-abc", ROTATED)

    expect(store.read("user-abc")).toEqual(ROTATED)
    expect(update).toContain(secretOf(ROTATED))
  })

  test("a write the keychain rejects throws instead of reading back the old account", () => {
    const held = secretOf(RECORD)
    const exec: CommandRunner = (_command, args) =>
      args[0] === "-i" ? { status: 45, stdout: "", stderr: "denied", unavailable: false } : ok(`${held}\n`)

    expect(() => new MacKeychainStore({ exec }).write("user-abc", ROTATED)).toThrow("rejected the key")
  })

  test("remove deletes the account and tolerates one that was never there", () => {
    let held: string | undefined = secretOf(RECORD)
    const exec: CommandRunner = (_command, args) => {
      if (args[0] === "delete-generic-password") {
        if (!held) return NOT_FOUND
        held = undefined
        return ok()
      }
      return held ? ok(`${held}\n`) : NOT_FOUND
    }
    const store = new MacKeychainStore({ exec })

    store.remove("user-abc")
    store.remove("user-abc")

    expect(store.read("user-abc")).toBeUndefined()
  })
})

describe("SecretServiceStore", () => {
  test("an account another process already wrote is returned instead of being overwritten", () => {
    const stored = secretOf({ keyId: "bik_winner", publicKey: "pub", privateKey: "priv" })
    const exec: CommandRunner = (_command, args) => {
      if (args[0] === "store") throw new Error("must not overwrite an existing account")
      return ok(`${stored}\n`)
    }
    expect(new SecretServiceStore({ exec }).createExclusive("host-abc", RECORD).keyId).toBe("bik_winner")
  })

  test("write replaces the stored account and remove clears it", () => {
    let held: string | undefined = secretOf(RECORD)
    const exec: CommandRunner = (_command, args, input) => {
      if (args[0] === "store") {
        held = input?.trim()
        return ok()
      }
      if (args[0] === "clear") {
        held = undefined
        return ok()
      }
      return held ? ok(`${held}\n`) : NOT_FOUND
    }
    const store = new SecretServiceStore({ exec })

    store.write("user-abc", ROTATED)
    expect(store.read("user-abc")).toEqual(ROTATED)

    store.remove("user-abc")
    expect(store.read("user-abc")).toBeUndefined()
  })

  test("a store that keeps the old private half under the same id is not mistaken for success", () => {
    const stale = secretOf({ ...RECORD, privateKey: "stale" })
    const exec: CommandRunner = (_command, args) => (args[0] === "store" ? ok() : ok(`${stale}\n`))

    expect(() => new SecretServiceStore({ exec }).write("user-abc", RECORD)).toThrow("did not store the key")
  })

  test("a keyring that swallows the write is reported, not mistaken for success", () => {
    const exec: CommandRunner = (_command, args) => (args[0] === "store" ? ok() : NOT_FOUND)

    expect(() => new SecretServiceStore({ exec }).write("user-abc", RECORD)).toThrow("did not store the key")
  })
})

describe("E2eKeyring", () => {
  test("adopts a pre-keyring BIK file under the scoped account, keeping its id", async () => {
    const legacyPath = join(tempDir(), "bik.json")
    writeFileSync(legacyPath, JSON.stringify({ publicKeyId: "bik_legacy", publicKey: "pub", privateKey: "priv" }))
    const keyring = new E2eKeyring({
      store: new FileKeyStore({ dir: tempDir() }),
      account: "host-abc",
      mint: async () => RECORD,
      legacy: () => readLegacyBikFile(legacyPath),
      log: () => {},
    })
    expect((await keyring.ensure())[0]!.keyId).toBe("bik_legacy")
  })

  test("a stored key beats the legacy file", async () => {
    const dir = tempDir()
    writeFileSync(join(dir, "host-abc.json"), JSON.stringify(RECORD))
    const keyring = new E2eKeyring({
      store: new FileKeyStore({ dir }),
      account: "host-abc",
      mint: async () => {
        throw new Error("must not mint")
      },
      legacy: () => ({ keyId: "bik_legacy", publicKey: "pub", privateKey: "priv" }),
      log: () => {},
    })
    expect((await keyring.ensure())[0]!.keyId).toBe("bik_1")
  })

  test("presence carries the keyring and the pre-registry scalar pair, naming one key", async () => {
    const keyring = new E2eKeyring({
      store: new FileKeyStore({ dir: tempDir() }),
      account: "host-abc",
      mint: async () => RECORD,
      log: () => {},
    })
    await keyring.ensure()
    expect(keyring.presenceFields()).toEqual({
      e2eKeys: [{ keyId: "bik_1", publicKey: "pub" }],
      publicKey: "pub",
      publicKeyId: "bik_1",
    })
  })

  test("the per-stream policy holds nothing until a grant, then one key per stream", async () => {
    let minted = 0
    const keyring = new E2eKeyring({
      store: new FileKeyStore({ dir: tempDir() }),
      account: null,
      mint: async () => ({ ...RECORD, keyId: `bik_${++minted}` }),
      legacy: () => ({ keyId: "bik_legacy", publicKey: "pub", privateKey: "priv" }),
      log: () => {},
    })

    expect(await keyring.ensure()).toEqual([])
    await keyring.ensureForStream("stream_a")
    await keyring.ensureForStream("stream_b")
    await keyring.ensureForStream("stream_a")

    expect(keyring.presenceFields()).toEqual({
      e2eKeys: [
        { keyId: "bik_1", publicKey: "pub", streamId: "stream_a" },
        { keyId: "bik_2", publicKey: "pub", streamId: "stream_b" },
      ],
    })
  })

  test("a revoke drops that stream's key and forgets where it was filed", async () => {
    let minted = 0
    const store = new FileKeyStore({ dir: tempDir() })
    const keyring = new E2eKeyring({
      store,
      account: null,
      mint: async () => ({ ...RECORD, keyId: `bik_${++minted}` }),
      log: () => {},
    })
    await keyring.ensureForStream("stream_a")
    await keyring.ensureForStream("stream_b")

    keyring.dropStream("stream_a")

    // Only the revoked stream's key goes, and it goes from the store too — a
    // record left on disk would come back on the next start and be advertised.
    expect(keyring.presenceFields()).toEqual({
      e2eKeys: [{ keyId: "bik_2", publicKey: "pub", streamId: "stream_b" }],
    })
    expect(store.read(e2eStreamKeyAccount("stream_a"))).toBeUndefined()
    expect(store.read(e2eStreamKeyAccount("stream_b"))?.keyId).toBe("bik_2")
  })

  test("a revoke leaves the default key alone — it covers every other stream", async () => {
    const store = new FileKeyStore({ dir: tempDir() })
    const keyring = new E2eKeyring({ store, account: "host-abc", mint: async () => RECORD, log: () => {} })
    await keyring.ensure()

    keyring.dropStream("stream_a")

    expect(keyring.presenceFields()).toEqual({
      e2eKeys: [{ keyId: "bik_1", publicKey: "pub" }],
      publicKey: "pub",
      publicKeyId: "bik_1",
    })
    expect(store.read("host-abc")?.keyId).toBe("bik_1")
  })

  test("concurrent grants for one stream mint a single key", async () => {
    let minted = 0
    const keyring = new E2eKeyring({
      store: new FileKeyStore({ dir: tempDir() }),
      account: null,
      mint: async () => {
        await Bun.sleep(1)
        return { ...RECORD, keyId: `bik_${++minted}` }
      },
      log: () => {},
    })

    await Promise.all([keyring.ensureForStream("stream_a"), keyring.ensureForStream("stream_a")])
    expect(keyring.current.map((key) => key.keyId)).toEqual(["bik_1"])
  })

  test("a default key already covers every stream, so a grant mints nothing", async () => {
    const keyring = new E2eKeyring({
      store: new FileKeyStore({ dir: tempDir() }),
      account: "host-abc",
      mint: async () => RECORD,
      log: () => {},
    })
    await keyring.ensure()
    await keyring.ensureForStream("stream_a")
    expect(keyring.presenceFields()).toEqual({
      e2eKeys: [{ keyId: "bik_1", publicKey: "pub" }],
      publicKey: "pub",
      publicKeyId: "bik_1",
    })
  })

  test("readLegacyBikFile ignores a missing or unreadable file", () => {
    const dir = tempDir()
    expect(readLegacyBikFile(join(dir, "absent.json"))).toBeUndefined()
    writeFileSync(join(dir, "bad.json"), "not json")
    expect(readLegacyBikFile(join(dir, "bad.json"))).toBeUndefined()
  })
})
