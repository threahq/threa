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

import { homedir } from "node:os"
import { join } from "node:path"
import {
  FileKeyStore,
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
  return choice.dir ?? process.env.THREA_E2E_KEY_DIR ?? join(homedir(), ".threa", "e2e-keys")
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

async function accountForKey(client: ThreaApiClient, workspaceId: string): Promise<string> {
  const me = await client.get<{ data: { kind: string; userId?: string } }>("/me")
  const userId = me.data.userId
  if (!userId) {
    throw new Error(
      `threa: end-to-end keys belong to a person, but this API key acts as ${me.data.kind}. ` +
        `Use your own key, not a bot's.`
    )
  }
  return e2eUserKeyAccount(workspaceId, userId)
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
