/**
 * The E2E keyring a bot runtime holds: the X25519 identity keys an owner wraps
 * a sealed stream's key to, and where they live on the operator's machine.
 *
 * A runtime used to hold exactly one key per install. It now advertises a
 * keyring, so several runtimes on one box can share a single key (the default —
 * one key per host) and a key can be pinned to one stream. The server stores
 * the advertised set as the instance's complete keyring and wraps every sealed
 * stream key to each eligible member.
 *
 * Keys are secrets, so where they are kept is the operator's explicit choice:
 * the OS keychain (driven through its command-line tool, which survives a
 * runtime being rebuilt and reinstalled) or a `0600` file. There is no silent
 * fallback between the two — an unavailable keychain is an error naming both
 * options, not a quiet downgrade to disk.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const E2E_KEY_SCOPES = ["host", "identity", "instance"] as const
export type E2eKeyScope = (typeof E2E_KEY_SCOPES)[number]

export const E2E_KEY_STORE_KINDS = ["keychain", "file"] as const
export type E2eKeyStoreKind = (typeof E2E_KEY_STORE_KINDS)[number]

/** A key as it is persisted and as it rides presence: public half plus the private key, base64. */
export interface E2eKeyRecord {
  keyId: string
  publicKey: string
  privateKey: string
}

/**
 * A place a key record is kept. `createExclusive` never overwrites: when
 * another process wrote the account first its record is returned instead, so
 * two runtimes racing to mint a shared key converge on one.
 */
export interface E2eKeyStore {
  readonly kind: E2eKeyStoreKind
  /** Where the keys live, for the boot log — a path or the keychain service. */
  readonly describe: string
  read(account: string): E2eKeyRecord | undefined
  createExclusive(account: string, record: E2eKeyRecord): E2eKeyRecord
}

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

/**
 * The account a scope's key is filed under. `host` hashes the hostname because
 * `~/.threa` can be a home directory shared across machines, and a key that
 * followed the home directory would put every box on one identity without the
 * operator ever choosing that.
 */
export function e2eKeyAccount(params: {
  scope: E2eKeyScope
  hostname: string
  instanceId: string
  /** Secret that identifies the bot (its API key); hashed, never stored. */
  identitySeed: string
}): string {
  switch (params.scope) {
    case "identity":
      return `identity-${hash16(params.identitySeed)}`
    case "instance":
      return `instance-${params.instanceId.replace(/[^A-Za-z0-9_-]+/g, "-")}`.slice(0, 96)
    case "host":
      return `host-${hash16(params.hostname)}`
  }
}

function decodeRecord(raw: string): E2eKeyRecord | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<E2eKeyRecord>
    if (
      typeof parsed.keyId === "string" &&
      typeof parsed.publicKey === "string" &&
      typeof parsed.privateKey === "string"
    ) {
      return { keyId: parsed.keyId, publicKey: parsed.publicKey, privateKey: parsed.privateKey }
    }
  } catch {
    // Reported by the caller, which knows which account was unreadable.
  }
  return undefined
}

export class FileKeyStore implements E2eKeyStore {
  readonly kind = "file" as const
  readonly describe: string
  private readonly dir: string

  constructor(opts: { dir: string }) {
    this.dir = opts.dir
    this.describe = opts.dir
  }

  private path(account: string): string {
    return join(this.dir, `${account}.json`)
  }

  read(account: string): E2eKeyRecord | undefined {
    const path = this.path(account)
    if (!existsSync(path)) return undefined
    return decodeRecord(readFileSync(path, "utf8"))
  }

  createExclusive(account: string, record: E2eKeyRecord): E2eKeyRecord {
    const path = this.path(account)
    mkdirSync(dirname(path), { recursive: true })
    try {
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: "wx" })
      return record
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error
      const winner = this.read(account)
      if (!winner) throw new Error(`${path} exists but could not be read`)
      return winner
    }
  }
}

interface CommandResult {
  status: number
  stdout: string
  stderr: string
  /** The command could not be run at all (binary missing). */
  unavailable: boolean
}

function run(command: string, args: string[], input?: string): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", input })
  if (result.error) {
    return { status: -1, stdout: "", stderr: String(result.error), unavailable: true }
  }
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "", unavailable: false }
}

export type CommandRunner = (command: string, args: string[], input?: string) => CommandResult

/** Keychain access is base64 so the record survives tools that split on whitespace or quotes. */
function encodeSecret(record: E2eKeyRecord): string {
  return Buffer.from(JSON.stringify(record), "utf8").toString("base64")
}

function decodeSecret(raw: string): E2eKeyRecord | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  return decodeRecord(Buffer.from(trimmed, "base64").toString("utf8"))
}

const KEYCHAIN_SERVICE = "threa-e2e"

/**
 * The macOS keychain, driven through `/usr/bin/security`. The command-line tool
 * rather than an in-process keychain API on purpose: a keychain item is bound
 * to the signature of the process that created it, so a runtime that is rebuilt
 * and reinstalled loses access to its own key — `security` is a stable system
 * binary and keeps it.
 */
export class MacKeychainStore implements E2eKeyStore {
  readonly kind = "keychain" as const
  readonly describe = `macOS keychain (service ${KEYCHAIN_SERVICE})`
  private readonly exec: CommandRunner

  constructor(opts: { exec?: CommandRunner } = {}) {
    this.exec = opts.exec ?? run
  }

  read(account: string): E2eKeyRecord | undefined {
    const result = this.exec("/usr/bin/security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      account,
      "-w",
    ])
    if (result.unavailable) throw new Error(`macOS keychain unavailable: ${result.stderr}`)
    if (result.status !== 0) return undefined
    return decodeSecret(result.stdout)
  }

  createExclusive(account: string, record: E2eKeyRecord): E2eKeyRecord {
    // The secret rides stdin (`security -i` reads commands there) so it never
    // appears in this process's argv, where any local `ps` would read it.
    const result = this.exec(
      "/usr/bin/security",
      ["-i"],
      `add-generic-password -s ${KEYCHAIN_SERVICE} -a ${account} -w ${encodeSecret(record)}\n`
    )
    if (result.unavailable) throw new Error(`macOS keychain unavailable: ${result.stderr}`)
    const stored = this.read(account)
    if (!stored) throw new Error(`macOS keychain accepted no key for ${account}: ${result.stderr || result.stdout}`)
    return stored
  }
}

/**
 * The freedesktop Secret Service, driven through `secret-tool`. `store`
 * overwrites, so exclusivity is a read before the write and a read after it:
 * the value that comes back is the one every process on this box will use.
 */
export class SecretServiceStore implements E2eKeyStore {
  readonly kind = "keychain" as const
  readonly describe = `Secret Service keyring (service ${KEYCHAIN_SERVICE})`
  private readonly exec: CommandRunner

  constructor(opts: { exec?: CommandRunner } = {}) {
    this.exec = opts.exec ?? run
  }

  read(account: string): E2eKeyRecord | undefined {
    const result = this.exec("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", account])
    if (result.unavailable) throw new Error(`Secret Service unavailable: ${result.stderr}`)
    if (result.status !== 0) return undefined
    return decodeSecret(result.stdout)
  }

  createExclusive(account: string, record: E2eKeyRecord): E2eKeyRecord {
    const existing = this.read(account)
    if (existing) return existing
    const result = this.exec(
      "secret-tool",
      ["store", "--label", `Threa E2E key ${account}`, "service", KEYCHAIN_SERVICE, "account", account],
      encodeSecret(record)
    )
    if (result.unavailable) throw new Error(`Secret Service unavailable: ${result.stderr}`)
    const stored = this.read(account)
    if (!stored) throw new Error(`Secret Service stored no key for ${account}: ${result.stderr || result.stdout}`)
    return stored
  }
}

export interface ResolveKeyStoreInput {
  /** The operator's explicit choice. Unset lets an available keychain win. */
  requested?: E2eKeyStoreKind
  platform: NodeJS.Platform
  /** Where a file store keeps its keys. */
  dir: string
  /** Already-persisted key material, when found: an existing file store keeps serving it. */
  hasExistingFileKey: boolean
  exec?: CommandRunner
}

/**
 * Pick the store for this machine. An explicit `keychain` that cannot run is an
 * error rather than a quiet move to disk (INV-11), and with nothing explicit a
 * box without a working keychain is asked to choose instead of being given one.
 */
export function resolveKeyStore(input: ResolveKeyStoreInput): E2eKeyStore {
  const keychain = (): E2eKeyStore =>
    input.platform === "darwin"
      ? new MacKeychainStore({ exec: input.exec })
      : new SecretServiceStore({ exec: input.exec })

  if (input.requested === "file") return new FileKeyStore({ dir: input.dir })
  if (input.requested === "keychain") {
    const store = keychain()
    store.read("threa-probe")
    return store
  }

  if (input.hasExistingFileKey) return new FileKeyStore({ dir: input.dir })
  const store = keychain()
  try {
    store.read("threa-probe")
    return store
  } catch (error) {
    throw new Error(
      `No OS keychain available for Threa's end-to-end keys (${String(error)}). ` +
        `Set keyStore to "keychain" once one is installed, or "file" to keep them in ${input.dir} at mode 0600.`
    )
  }
}

export interface E2eKeyringOptions {
  store: E2eKeyStore
  /** The account the unscoped default key is filed under; see {@link e2eKeyAccount}. */
  account: string
  /** Mints a fresh record when the account is empty. */
  mint: () => Promise<E2eKeyRecord>
  /**
   * A single-key file from before the keyring. When the account holds nothing
   * and this does, the old key is adopted under the new account: its id is the
   * address of every wrap an owner already made, so minting a fresh one instead
   * would strand every sealed stream the runtime serves.
   */
  legacy?: () => E2eKeyRecord | undefined
  log?: (message: string) => void
}

/**
 * This runtime's keyring. `ensure()` loads or mints the default key once; the
 * result is what rides `bot:hello` and every presence write, where the server
 * reads it as the instance's complete set.
 */
export class E2eKeyring {
  private readonly opts: E2eKeyringOptions
  private readonly log: (message: string) => void
  private records: E2eKeyRecord[] = []
  private inFlight: Promise<E2eKeyRecord[]> | undefined
  private loaded = false

  constructor(opts: E2eKeyringOptions) {
    this.opts = opts
    this.log = opts.log ?? ((message) => console.error(message))
  }

  /** The loaded records; empty until `ensure()` resolves. */
  get current(): E2eKeyRecord[] {
    return this.records
  }

  async ensure(): Promise<E2eKeyRecord[]> {
    if (this.loaded) return this.records
    // Boot presence and `bot:hello` both ensure; without this they would each
    // mint past the cache check and race the store.
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined
    })
    this.records = await this.inFlight
    this.loaded = this.records.length > 0
    return this.records
  }

  /**
   * The keyring as it rides presence. `publicKey`/`publicKeyId` carry the
   * default key as well: a server from before the registry reads only those,
   * and both name the same key, so a mixed-version rollout addresses one key
   * either way.
   */
  presenceFields():
    | { e2eKeys: { keyId: string; publicKey: string }[]; publicKey: string; publicKeyId: string }
    | Record<string, never> {
    const [primary, ...rest] = this.records
    if (!primary) return {}
    return {
      e2eKeys: [primary, ...rest].map((record) => ({ keyId: record.keyId, publicKey: record.publicKey })),
      publicKey: primary.publicKey,
      publicKeyId: primary.keyId,
    }
  }

  private async load(): Promise<E2eKeyRecord[]> {
    const stored = this.opts.store.read(this.opts.account)
    if (stored) return [stored]

    const legacy = this.opts.legacy?.()
    if (legacy) {
      const adopted = this.opts.store.createExclusive(this.opts.account, legacy)
      this.log(
        `Threa sealed: adopted this install's existing key ${adopted.keyId} into ${this.opts.store.describe} as ${this.opts.account}`
      )
      return [adopted]
    }

    const minted = this.opts.store.createExclusive(this.opts.account, await this.opts.mint())
    this.log(`Threa sealed: end-to-end key ${minted.keyId} is in ${this.opts.store.describe} as ${this.opts.account}`)
    return [minted]
  }
}

/**
 * Read the single-key BIK file a runtime used before keyrings. Its `publicKeyId`
 * is the address of every wrap the owner already made for this install, so the
 * record is adopted under the configured scope rather than replaced.
 */
export function readLegacyBikFile(path: string): E2eKeyRecord | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    if (
      typeof parsed.publicKeyId === "string" &&
      typeof parsed.publicKey === "string" &&
      typeof parsed.privateKey === "string"
    ) {
      return { keyId: parsed.publicKeyId, publicKey: parsed.publicKey, privateKey: parsed.privateKey }
    }
  } catch {
    // An unreadable legacy file is not fatal: a fresh key is minted instead.
  }
  return undefined
}
