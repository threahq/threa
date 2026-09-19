/**
 * Sealed-stream fixtures for a bot principal: the key a connector's keyring
 * files on this machine, the wrap an owner writes to it, and a row sealed under
 * the stream key. Built with the product's own crypto, so a test that opens one
 * proves the CLI reads what the workspace actually wrote.
 */

import { Aes256Gcm, CipherSuite, HkdfSha256 } from "@hpke/core"
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519"
import { hostname } from "node:os"
import {
  base64ToBytes,
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  sealMessage,
  serializeSealedPayload,
} from "../../../extensions/bot-runtime-client/src/crypto"
import { e2eKeyAccount, FileKeyStore, type E2eKeyRecord } from "../../../extensions/bot-runtime-client/src/keyring"
import { mintE2eKeyRecord } from "../../../extensions/bot-runtime-client/src/sealed"

// Bun's WebCrypto throws on X25519 encap, so the wrap side runs on the noble
// KEM — the same RFC 9180 DHKEM(X25519), wire-interoperable.
const nobleSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
})

/** Mint a key and file it where a connector running `keyScope: "host"` keeps it. */
export async function connectorHostKey(params: { dir: string; apiKey: string }): Promise<E2eKeyRecord> {
  const account = e2eKeyAccount({
    scope: "host",
    hostname: hostname(),
    instanceId: "",
    identitySeed: params.apiKey,
  })!
  const record = await mintE2eKeyRecord()
  new FileKeyStore({ dir: params.dir }).write(account, record)
  return record
}

/** The stream key wrapped to one recipient, as a grant writes it. */
export async function wrapStreamKey(params: {
  streamId: string
  keyGeneration: number
  recipient: E2eKeyRecord
  streamKey: Uint8Array
}) {
  const publicKey = base64ToBytes(params.recipient.publicKey)
  const sealed = await nobleSuite.seal(
    {
      recipientPublicKey: await nobleSuite.kem.deserializePublicKey(
        publicKey.buffer.slice(publicKey.byteOffset, publicKey.byteOffset + publicKey.byteLength)
      ),
    },
    params.streamKey,
    buildWrapAad({
      streamId: params.streamId,
      keyGeneration: params.keyGeneration,
      recipientKeyId: params.recipient.keyId,
    })
  )
  return {
    keyGeneration: params.keyGeneration,
    recipientKeyId: params.recipient.keyId,
    wrapEnc: bytesToBase64(new Uint8Array(sealed.enc)),
    wrapCt: bytesToBase64(new Uint8Array(sealed.ct)),
  }
}

/** A message row as the server stores it: a zero-width placeholder beside the envelope. */
export async function sealedMessageRow(params: {
  streamId: string
  messageId: string
  senderId: string
  keyGeneration: number
  streamKey: Uint8Array
  contentMarkdown: string
  sequence: string
}): Promise<Record<string, unknown>> {
  const sealed = await sealMessage({
    key: params.streamKey,
    keyGeneration: params.keyGeneration,
    payload: serializeSealedPayload(params.contentMarkdown),
    aad: buildMessageAad({ streamId: params.streamId, messageId: params.messageId, senderId: params.senderId }),
  })
  return {
    id: params.messageId,
    sequence: params.sequence,
    authorId: params.senderId,
    authorType: "bot",
    createdAt: "2026-09-19T09:00:00.000Z",
    content: "​",
    sealed: { ciphertext: bytesToBase64(sealed.ciphertext), envelope: sealed.envelope },
  }
}
