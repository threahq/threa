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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const E2E_KEY_SCOPES = ["host", "identity", "instance", "stream"] as const
export type E2eKeyScope = (typeof E2E_KEY_SCOPES)[number]

export const E2E_KEY_STORE_KINDS = ["keychain", "file"] as const
export type E2eKeyStoreKind = (typeof E2E_KEY_STORE_KINDS)[number]

/** A key as it is persisted and as it rides presence: public half plus the private key, base64. */
export interface E2eKeyRecord {
  keyId: string
  publicKey: string
  privateKey: string
}

/** A held key, the account it came from, and the stream it is pinned to, if any. */
export interface HeldE2eKey extends E2eKeyRecord {
  account: string
  streamId?: string
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
  /**
   * Replace whatever is filed under `account`. For a person acting on their own
   * key — unlocking it on this machine, or replacing it after a rotation. A
   * runtime converging with its peers on a shared key wants `createExclusive`,
   * which never clobbers the winner of that race.
   */
  write(account: string, record: E2eKeyRecord): void
  /** Forget the account. Silent when nothing is filed there. */
  remove(account: string): void
}

function hash16(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16)
}

/**
 * The account a scope's default key is filed under, or `null` under `stream`,
 * where there is no default: each key is minted for one sealed stream on its
 * grant and filed under {@link e2eStreamKeyAccount}.
 *
 * `host` hashes the hostname because `~/.threa` can be a home directory shared
 * across machines, and a key that followed the home directory would put every
 * box on one identity without the operator ever choosing that.
 */
export function e2eKeyAccount(params: {
  scope: E2eKeyScope
  hostname: string
  instanceId: string
  /** Secret that identifies the bot (its API key); hashed, never stored. */
  identitySeed: string
}): string | null {
  switch (params.scope) {
    case "identity":
      return `identity-${hash16(params.identitySeed)}`
    case "instance":
      return `instance-${params.instanceId.replace(/[^A-Za-z0-9_-]+/g, "-")}`.slice(0, 96)
    case "host":
      return `host-${hash16(params.hostname)}`
    case "stream":
      return null
  }
}

/** The account one stream's key is filed under. */
export function e2eStreamKeyAccount(streamId: string): string {
  return `stream-${hash16(streamId)}`
}

/**
 * The account a person's own identity key is filed under, once they unlock it
 * on this machine. Separate from the bot scopes above: this is the key the web
 * app minted from their passphrase, and a CLI holding it reads their streams as
 * them, not as a runtime.
 */
export function e2eUserKeyAccount(workspaceId: string, userId: string): string {
  return `user-${hash16(`${workspaceId}:${userId}`)}`
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

  /**
   * Whether this directory already serves any key. The per-stream policy has no
   * single account to probe for — its keys are named after streams it has not
   * been granted yet — so store selection asks this instead.
   */
  hasAny(): boolean {
    if (!existsSync(this.dir)) return false
    return readdirSync(this.dir).some((entry) => entry.endsWith(".json"))
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

  write(account: string, record: E2eKeyRecord): void {
    const path = this.path(account)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  }

  remove(account: string): void {
    rmSync(this.path(account), { force: true })
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
const sameRecord = (a: E2eKeyRecord, b: E2eKeyRecord): boolean =>
  a.keyId === b.keyId && a.publicKey === b.publicKey && a.privateKey === b.privateKey

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

  write(account: string, record: E2eKeyRecord): void {
    // `-U` updates in place; without it `add-generic-password` fails on an
    // account that already exists. Secret on stdin, as above.
    const result = this.exec(
      "/usr/bin/security",
      ["-i"],
      `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${account} -w ${encodeSecret(record)}\n`
    )
    if (result.unavailable) throw new Error(`macOS keychain unavailable: ${result.stderr}`)
    if (result.status !== 0) {
      throw new Error(`macOS keychain rejected the key for ${account}: ${result.stderr || result.stdout}`)
    }
    const stored = this.read(account)
    if (!stored || !sameRecord(stored, record)) {
      throw new Error(`macOS keychain did not store the key for ${account}: ${result.stderr || result.stdout}`)
    }
  }

  remove(account: string): void {
    const result = this.exec("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account])
    if (result.unavailable) throw new Error(`macOS keychain unavailable: ${result.stderr}`)
    // A non-zero status here is "no such item", which is the state asked for.
    if (this.read(account)) throw new Error(`macOS keychain kept the key for ${account}: ${result.stderr}`)
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

  write(account: string, record: E2eKeyRecord): void {
    const result = this.exec(
      "secret-tool",
      ["store", "--label", `Threa E2E key ${account}`, "service", KEYCHAIN_SERVICE, "account", account],
      encodeSecret(record)
    )
    if (result.unavailable) throw new Error(`Secret Service unavailable: ${result.stderr}`)
    if (result.status !== 0) {
      throw new Error(`Secret Service rejected the key for ${account}: ${result.stderr || result.stdout}`)
    }
    const stored = this.read(account)
    if (!stored || !sameRecord(stored, record)) {
      throw new Error(`Secret Service did not store the key for ${account}: ${result.stderr || result.stdout}`)
    }
  }

  remove(account: string): void {
    const result = this.exec("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", account])
    if (result.unavailable) throw new Error(`Secret Service unavailable: ${result.stderr}`)
    if (this.read(account)) throw new Error(`Secret Service kept the key for ${account}: ${result.stderr}`)
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
  /**
   * The account the unscoped default key is filed under; see
   * {@link e2eKeyAccount}. `null` selects the per-stream policy: no default
   * key, one minted per sealed stream the bot is granted.
   */
  account: string | null
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
 * This runtime's keyring. `ensure()` loads or mints the default key once;
 * `ensureForStream()` adds a stream-pinned key under the per-stream policy. The
 * result is what rides `bot:hello` and every presence write, where the server
 * reads it as the instance's complete set.
 */
export class E2eKeyring {
  private readonly opts: E2eKeyringOptions
  private readonly log: (message: string) => void
  private held: HeldE2eKey[] = []
  private inFlight = new Map<string, Promise<HeldE2eKey[]>>()
  private loaded = false

  constructor(opts: E2eKeyringOptions) {
    this.opts = opts
    this.log = opts.log ?? ((message) => console.error(message))
  }

  /** The loaded keys; empty until `ensure()` resolves. */
  get current(): HeldE2eKey[] {
    return this.held
  }

  async ensure(): Promise<HeldE2eKey[]> {
    if (this.loaded) return this.held
    const account = this.opts.account
    if (account === null) {
      // Per-stream: nothing to hold until the first grant arrives.
      this.loaded = true
      return this.held
    }
    await this.loadAccount(account, undefined)
    this.loaded = this.held.length > 0
    return this.held
  }

  /**
   * The key this runtime reads `streamId` with. Under the default policy that
   * is the unscoped key, which already covers every stream, so this is a no-op.
   * Under the per-stream policy it mints one key for this stream — the owner's
   * next re-wrap addresses the stream key to it.
   */
  async ensureForStream(streamId: string): Promise<HeldE2eKey[]> {
    if (this.opts.account !== null) return this.ensure()
    return this.loadAccount(e2eStreamKeyAccount(streamId), streamId)
  }

  /**
   * The key a wrap for `streamId` must be addressed to, once `ensureForStream`
   * has resolved. Under the default policy that is the unscoped key whatever
   * the stream; under the per-stream policy picking the first held key would
   * address another stream's.
   */
  forStream(streamId: string): HeldE2eKey | undefined {
    if (this.opts.account !== null) return this.held.find((key) => !key.streamId)
    return this.held.find((key) => key.streamId === streamId)
  }

  /**
   * The keyring as it rides presence. `publicKey`/`publicKeyId` carry the
   * default key as well: a server from before the registry reads only those,
   * and both name the same key, so a mixed-version rollout addresses one key
   * either way. Under the per-stream policy there is no default key, so those
   * two are omitted rather than naming a stream key an old server would
   * register as covering everything.
   */
  presenceFields():
    | { e2eKeys: { keyId: string; publicKey: string; streamId?: string }[]; publicKey?: string; publicKeyId?: string }
    | Record<string, never> {
    if (this.held.length === 0) return {}
    const e2eKeys = this.held.map((key) => ({
      keyId: key.keyId,
      publicKey: key.publicKey,
      ...(key.streamId ? { streamId: key.streamId } : {}),
    }))
    const unscoped = this.held.find((key) => !key.streamId)
    return unscoped ? { e2eKeys, publicKey: unscoped.publicKey, publicKeyId: unscoped.keyId } : { e2eKeys }
  }

  /**
   * Load or mint one account's key and fold it into the held set. Concurrent
   * callers for the same account share one attempt: boot presence and
   * `bot:hello` both ensure, and a grant can arrive while either is in flight,
   * so without this they would each mint past the cache check and race the
   * store.
   */
  private async loadAccount(account: string, streamId: string | undefined): Promise<HeldE2eKey[]> {
    const existing = this.held.find((key) => key.account === account)
    if (existing) return this.held
    let attempt = this.inFlight.get(account)
    if (!attempt) {
      attempt = this.mintAccount(account, streamId).finally(() => this.inFlight.delete(account))
      this.inFlight.set(account, attempt)
    }
    return attempt
  }

  private async mintAccount(account: string, streamId: string | undefined): Promise<HeldE2eKey[]> {
    const record = this.opts.store.read(account) ?? (await this.createRecord(account))
    if (!this.held.some((key) => key.account === account)) {
      this.held = [...this.held, { ...record, account, ...(streamId ? { streamId } : {}) }]
    }
    return this.held
  }

  private async createRecord(account: string): Promise<E2eKeyRecord> {
    // Only the default key adopts the pre-keyring file. Filing that one record
    // under a second account too would advertise one key id twice, which the
    // server rejects as a duplicate keyring entry.
    const legacy = account === this.opts.account ? this.opts.legacy?.() : undefined
    if (legacy) {
      const adopted = this.opts.store.createExclusive(account, legacy)
      this.log(
        `Threa sealed: adopted this install's existing key ${adopted.keyId} into ${this.opts.store.describe} as ${account}`
      )
      return adopted
    }
    const minted = this.opts.store.createExclusive(account, await this.opts.mint())
    this.log(`Threa sealed: end-to-end key ${minted.keyId} is in ${this.opts.store.describe} as ${account}`)
    return minted
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
