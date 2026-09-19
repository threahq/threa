/**
 * Reading and writing an end-to-end-encrypted stream from the CLI.
 *
 * The heavy lifting is the SDK's `SealedStreamClient`: it fetches the stream's
 * key wraps, unwraps the stream key under a private key the caller holds, and
 * opens or seals each body. This module supplies that client with the one key
 * `threa e2e unlock` filed on this machine, and keeps it out of the way until a
 * sealed stream actually turns up — a plaintext workspace never touches a key
 * store, and an unlocked key is imported at most once per process.
 */

import {
  SealedStreamClient,
  type OpenedSealedBody,
  type SealedKeySource,
  type SealedMessageBody,
} from "../../../extensions/bot-runtime-client/src/sealed-stream-client"
import { base64ToBytes, importRecipientPrivateKey } from "../../../extensions/bot-runtime-client/src/crypto"
import type { ThreaApiClient } from "./api-client"
import type { ThreaConfig } from "./config"
import { readHeldUserKey, type KeyStoreChoice } from "./e2e-keys"

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

export const NO_KEY_HINT =
  'threa: this stream is end-to-end encrypted, and no key is unlocked on this machine — run "threa e2e unlock"'

export function sealedStreams(params: {
  client: ThreaApiClient
  config: ThreaConfig
  choice: KeyStoreChoice
}): SealedStreams {
  let pending: Promise<SealedStreamClient> | undefined

  async function build(): Promise<SealedStreamClient> {
    const held = await readHeldUserKey({
      client: params.client,
      workspaceId: params.config.workspaceId,
      choice: params.choice,
    })
    if (!held) throw new Error(NO_KEY_HINT)
    const identity = {
      keyId: held.record.keyId,
      privateKey: await importRecipientPrivateKey(base64ToBytes(held.record.privateKey)),
    }
    // One identity key covers every stream the CLI reaches: the workspace wraps
    // each stream key to it. A per-stream policy would ask the key store here.
    const keys: SealedKeySource = { keysForStream: () => Promise.resolve([identity]) }
    return new SealedStreamClient({
      baseUrl: params.config.baseUrl,
      apiKey: params.config.apiKey,
      workspaceId: params.config.workspaceId,
      keys,
      senderId: held.userId,
    })
  }

  function sealedClient(): Promise<SealedStreamClient> {
    if (!pending) {
      pending = build().catch((error: unknown) => {
        pending = undefined
        throw error
      })
    }
    return pending
  }

  return {
    async open(streamId, sealed) {
      return (await sealedClient()).openSealedBody(streamId, sealed)
    },
    async send(streamId, contentMarkdown, opts) {
      return (await sealedClient()).sendMessage(streamId, contentMarkdown, {
        ...(opts.clientMessageId === undefined ? {} : { clientMessageId: opts.clientMessageId }),
      })
    },
  }
}
