/**
 * The CLI's half of end-to-end encryption: your own identity key, unlocked
 * from your passphrase and kept on this machine.
 *
 * The web app mints the key, wraps its private half under an Argon2id key
 * derived from a passphrase, and hands the server only the ciphertext. A CLI
 * that has never run the web app fetches that bundle, repeats the derivation
 * locally, and files the opened key where the bot runtimes already keep theirs
 * (`~/.threa/e2e-keys`, in the OS keychain or a `0600` file) so sealed reads
 * and sends work without asking for the passphrase again.
 *
 * Nothing here ever sends the passphrase or the private key anywhere.
 */

import { homedir, hostname } from "node:os"
import { join } from "node:path"
import {
  FileKeyStore,
  e2eKeyAccount,
  e2eStreamKeyAccount,
  e2eUserKeyAccount,
  resolveKeyStore,
  type E2eKeyRecord,
  type E2eKeyStore,
  type E2eKeyStoreKind,
} from "../../../extensions/bot-runtime-client/src/keyring"
import { bytesToBase64, base64ToBytes, exportPrivateKey } from "../../../extensions/bot-runtime-client/src/crypto"
import {
  unlockUserKey,
  WrongPassphraseError,
  type KdfParams,
} from "../../../extensions/bot-runtime-client/src/user-key"
import { ThreaApiError, type ThreaApiClient } from "./api-client"
import type { ThreaConfig } from "./config"

export interface ServerUserKey {
  keyId: string
  publicKey: string
  encryptedPrivateBundle: string
  kdfSalt: string
  kdfParams: KdfParams
  createdAt: string
}

export interface KeyStoreChoice {
  /** The operator's explicit choice. Unset lets an available keychain win. */
  requested?: E2eKeyStoreKind
  /** Where a file store keeps its keys. Defaults to the runtimes' own directory. */
  dir?: string
}

export function keyDirOf(choice: KeyStoreChoice): string {
  return choice.dir ?? join(homedir(), ".threa", "e2e-keys")
}

/** The store this machine keeps the key in, and the account it is filed under. */
export function openKeyStore(choice: KeyStoreChoice, account: string): E2eKeyStore {
  const dir = keyDirOf(choice)
  return resolveKeyStore({
    ...(choice.requested === undefined ? {} : { requested: choice.requested }),
    platform: process.platform,
    dir,
    hasExistingFileKey: new FileKeyStore({ dir }).read(account) !== undefined,
  })
}

interface Principal {
  kind: string
  userId?: string
  botId?: string
}

function fetchPrincipal(client: ThreaApiClient): Promise<Principal> {
  return client.get<{ data: Principal }>("/me").then((response) => response.data)
}

async function principalForKey(
  client: ThreaApiClient,
  workspaceId: string
): Promise<{
  account: string
  userId: string
}> {
  const me = await fetchPrincipal(client)
  const userId = me.userId
  if (!userId) {
    throw new Error(
      `threa: end-to-end keys belong to a person, but this API key acts as ${me.kind}. ` +
        `Use your own key, not a bot's.`
    )
  }
  return { account: e2eUserKeyAccount(workspaceId, userId), userId }
}

/** How a caller addresses the key that opens one stream, and what to say when it is not here. */
export interface SealedKeyAccounts {
  /** The actor id bound into outgoing sealed bodies. */
  senderId: string
  /** Where this machine files the key for `streamId`. */
  accountFor(streamId: string): string
  /** Told to the operator when that account holds nothing. */
  missingKeyHint(account: string, store: E2eKeyStore): string
}

export const NO_USER_KEY_HINT =
  'threa: this stream is end-to-end encrypted, and no key is unlocked on this machine — run "threa e2e unlock"'

/**
 * Which key this invocation reads sealed streams with. A person reads with the
 * identity key `threa e2e unlock` filed for them; a bot key reads with the key
 * its runtime holds, under the scope that runtime was configured with — so a
 * CLI launched beside a connector addresses the same account the connector
 * advertised to the workspace.
 */
export async function resolveSealedKeyAccounts(params: {
  client: ThreaApiClient
  config: ThreaConfig
}): Promise<SealedKeyAccounts> {
  const me = await fetchPrincipal(params.client)
  if (me.kind !== "bot") {
    const userId = me.userId
    if (!userId) throw new Error(`threa: GET /me named no principal id for ${me.kind}`)
    const account = e2eUserKeyAccount(params.config.workspaceId, userId)
    return { senderId: userId, accountFor: () => account, missingKeyHint: () => NO_USER_KEY_HINT }
  }

  const botId = me.botId
  if (!botId) throw new Error("threa: GET /me named no bot id")
  const scope = params.config.keyScope ?? "host"
  if (scope === "instance" && !params.config.instanceId) {
    throw new Error('threa: keyScope "instance" needs an instanceId in the config (THREA_INSTANCE_ID)')
  }
  const account = e2eKeyAccount({
    scope,
    hostname: hostname(),
    instanceId: params.config.instanceId ?? "",
    identitySeed: params.config.apiKey,
  })
  return {
    senderId: botId,
    accountFor: (streamId) => account ?? e2eStreamKeyAccount(streamId),
    missingKeyHint: (missing, store) =>
      `threa: this stream is end-to-end encrypted, and this bot holds no key in ${store.describe} ` +
      `as ${missing} — start the runtime that owns this key, or set keyScope to the one it uses ` +
      `(currently "${scope}")`,
  }
}

async function accountForKey(client: ThreaApiClient, workspaceId: string): Promise<string> {
  return (await principalForKey(client, workspaceId)).account
}

export interface UnlockResult {
  keyId: string
  account: string
  store: E2eKeyStoreKind
  storeDescription: string
  createdAt: string
  /** The key already held here was the same one — nothing had to be replaced. */
  unchanged: boolean
}

export async function unlockE2eKey(params: {
  client: ThreaApiClient
  workspaceId: string
  passphrase: string
  choice: KeyStoreChoice
}): Promise<UnlockResult> {
  if (!params.passphrase) throw new Error("threa: no passphrase given")
  const account = await accountForKey(params.client, params.workspaceId)
  const key = (await params.client.get<{ data: ServerUserKey }>("/me/e2e-key")).data

  // The GCM tag is the only check there is: a wrong passphrase derives a wrong
  // key and fails here, never later as garbled plaintext. Anything else the
  // unlock throws is a real fault and keeps its own message.
  const privateKey = await unlockUserKey({
    passphrase: params.passphrase,
    encryptedPrivateBundle: base64ToBytes(key.encryptedPrivateBundle),
    kdfSalt: base64ToBytes(key.kdfSalt),
    kdfParams: key.kdfParams,
  }).catch((error: unknown) => {
    if (error instanceof WrongPassphraseError) {
      throw new Error("threa: that passphrase does not open your encryption key")
    }
    throw error
  })

  const record: E2eKeyRecord = {
    keyId: key.keyId,
    publicKey: key.publicKey,
    privateKey: bytesToBase64(await exportPrivateKey(privateKey)),
  }
  const store = openKeyStore(params.choice, account)
  const held = store.read(account)
  if (held?.keyId !== record.keyId || held.privateKey !== record.privateKey) store.write(account, record)

  return {
    keyId: record.keyId,
    account,
    store: store.kind,
    storeDescription: store.describe,
    createdAt: key.createdAt,
    unchanged: held?.keyId === record.keyId && held.privateKey === record.privateKey,
  }
}

export interface E2eKeyStatus {
  held: boolean
  /** The key this machine holds, when it holds one. */
  keyId?: string
  /** The workspace's active key for you, when you have set one up. */
  serverKeyId?: string
  /** Held and current. False with a held key means the web app has since rotated it. */
  current: boolean
  account: string
  store: E2eKeyStoreKind
  storeDescription: string
}

export async function e2eKeyStatus(params: {
  client: ThreaApiClient
  workspaceId: string
  choice: KeyStoreChoice
}): Promise<E2eKeyStatus> {
  const account = await accountForKey(params.client, params.workspaceId)
  const store = openKeyStore(params.choice, account)
  const held = store.read(account)
  const serverKeyId = await params.client
    .get<{ data: ServerUserKey }>("/me/e2e-key")
    .then((response) => response.data.keyId)
    .catch((error: unknown) => {
      // No key set up yet is a state to report, not a failure to read one.
      if (error instanceof ThreaApiError && error.status === 404) return undefined
      throw error
    })
  return {
    held: held !== undefined,
    ...(held ? { keyId: held.keyId } : {}),
    ...(serverKeyId === undefined ? {} : { serverKeyId }),
    current: held !== undefined && held.keyId === serverKeyId,
    account,
    store: store.kind,
    storeDescription: store.describe,
  }
}

export interface LockResult {
  account: string
  store: E2eKeyStoreKind
  storeDescription: string
  /** False when this machine was not holding a key to begin with. */
  removed: boolean
}

export async function lockE2eKey(params: {
  client: ThreaApiClient
  workspaceId: string
  choice: KeyStoreChoice
}): Promise<LockResult> {
  const account = await accountForKey(params.client, params.workspaceId)
  const store = openKeyStore(params.choice, account)
  const removed = store.read(account) !== undefined
  store.remove(account)
  return { account, store: store.kind, storeDescription: store.describe, removed }
}
