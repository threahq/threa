/**
 * Reading and writing an end-to-end-encrypted stream from the CLI.
 *
 * The heavy lifting is the SDK's `SealedStreamClient`: it fetches the stream's
 * key wraps, unwraps the stream key under a private key the caller holds, and
 * opens or seals each body. This module supplies that client with the key this
 * machine holds for the caller — a person's own, filed by `threa e2e unlock`,
 * or the one a bot's runtime keeps under its configured scope — and keeps it
 * out of the way until a sealed stream actually turns up, so a plaintext
 * workspace never touches a key store.
 */

import {
  SealedStreamClient,
  type OpenedSealedBody,
  type SealedKeyIdentity,
  type SealedKeySource,
  type SealedMessageBody,
} from "../../../extensions/bot-runtime-client/src/sealed-stream-client"
import { base64ToBytes, importRecipientPrivateKey } from "../../../extensions/bot-runtime-client/src/crypto"
import type { ThreaApiClient } from "./api-client"
import type { ThreaConfig } from "./config"
import { openKeyStore, resolveSealedKeyAccounts, type KeyStoreChoice } from "./e2e-keys"

/** What the read and send paths need from a sealed stream, without the keys. */
export interface SealedStreams {
  /** Open a body that arrived over the plaintext message route. */
  open(streamId: string, sealed: SealedMessageBody): Promise<OpenedSealedBody>
  send(
    streamId: string,
    contentMarkdown: string,
    opts: { clientMessageId?: string }
  ): Promise<{ messageId: string; clientMessageId: string }>
}

export function sealedStreams(params: {
  client: ThreaApiClient
  config: ThreaConfig
  choice: KeyStoreChoice
}): SealedStreams {
  let pending: Promise<Sealed> | undefined

  interface Sealed {
    client: SealedStreamClient
    /** Throws when this machine holds no key for the stream. */
    identityFor(streamId: string): Promise<SealedKeyIdentity>
  }

  async function build(): Promise<Sealed> {
    const accounts = await resolveSealedKeyAccounts({ client: params.client, config: params.config })
    const imported = new Map<string, Promise<SealedKeyIdentity>>()

    // The key store is read, never minted into: a key this process created
    // would address no wrap the workspace ever made, so a missing one is a
    // setup error to report rather than a key to invent.
    function identityFor(streamId: string): Promise<SealedKeyIdentity> {
      const account = accounts.accountFor(streamId)
      let identity = imported.get(account)
      if (!identity) {
        const store = openKeyStore(params.choice, account)
        const record = store.read(account)
        if (!record) return Promise.reject(new Error(accounts.missingKeyHint(account, store)))
        identity = importRecipientPrivateKey(base64ToBytes(record.privateKey)).then((privateKey) => ({
          keyId: record.keyId,
          privateKey,
        }))
        imported.set(account, identity)
      }
      return identity
    }

    const keys: SealedKeySource = { keysForStream: async (streamId) => [await identityFor(streamId)] }

    return {
      identityFor,
      client: new SealedStreamClient({
        baseUrl: params.config.baseUrl,
        apiKey: params.config.apiKey,
        workspaceId: params.config.workspaceId,
        keys,
        senderId: accounts.senderId,
      }),
    }
  }

  function sealed(): Promise<Sealed> {
    if (!pending) {
      pending = build().catch((error: unknown) => {
        pending = undefined
        throw error
      })
    }
    return pending
  }

  return {
    async open(streamId, body) {
      const { client, identityFor } = await sealed()
      // Ask for the key first: the client reports anything it cannot open as an
      // unreadable row, which is right for one revoked generation and wrong for
      // "no key here at all" — that is the whole page, and the caller is told.
      await identityFor(streamId)
      return client.openSealedBody(streamId, body)
    },
    async send(streamId, contentMarkdown, opts) {
      const { client, identityFor } = await sealed()
      await identityFor(streamId)
      return client.sendMessage(streamId, contentMarkdown, {
        ...(opts.clientMessageId === undefined ? {} : { clientMessageId: opts.clientMessageId }),
      })
    },
  }
}
