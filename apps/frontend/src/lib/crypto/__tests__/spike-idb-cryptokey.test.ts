/**
 * THROWAWAY SPIKE (Option-1 feasibility) — delete before shipping.
 *
 * Question: can the X25519 private `CryptoKey` produced by `@threa/crypto`
 * (which goes through native `crypto.subtle` under the hood) survive an
 * IndexedDB put+get round-trip and remain usable for `hpke.open`? And can we
 * get a NON-EXTRACTABLE variant that still decrypts?
 *
 * We exercise the real `indexedDB` (fake-indexeddb is loaded in test setup),
 * not `structuredClone`, so the structured-clone path matches production.
 */
import { describe, expect, it } from "vitest"
import {
  exportPrivateKey,
  exportPublicKey,
  generateKeyPair,
  importRecipientPrivateKey,
  open,
  seal,
} from "@threa/crypto"

const STORE = "spike"

function putAndGet<T>(value: T): Promise<T> {
  return new Promise((resolve, reject) => {
    const dbName = `spike-${crypto.randomUUID()}`
    const openReq = indexedDB.open(dbName, 1)
    openReq.onupgradeneeded = () => {
      openReq.result.createObjectStore(STORE)
    }
    openReq.onerror = () => reject(openReq.error)
    openReq.onsuccess = () => {
      const idb = openReq.result
      const writeTx = idb.transaction(STORE, "readwrite")
      // A failed structured-clone of the value surfaces here.
      let putReq: IDBRequest
      try {
        putReq = writeTx.objectStore(STORE).put(value, "k")
      } catch (err) {
        idb.close()
        reject(err)
        return
      }
      putReq.onerror = () => {
        idb.close()
        reject(putReq.error)
      }
      writeTx.oncomplete = () => {
        const readTx = idb.transaction(STORE, "readonly")
        const getReq = readTx.objectStore(STORE).get("k")
        getReq.onerror = () => {
          idb.close()
          reject(getReq.error)
        }
        getReq.onsuccess = () => {
          idb.close()
          resolve(getReq.result as T)
        }
      }
    }
  })
}

// X25519 PKCS#8 prefix (lifted from @hpke/core's x25519 primitive). Wrapping
// the 32 raw private bytes lets us re-import with our OWN extractable flag.
const PKCS8_ALG_ID_X25519 = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])

async function importNonExtractablePrivate(rawPriv: Uint8Array): Promise<CryptoKey> {
  const pkcs8 = new Uint8Array(PKCS8_ALG_ID_X25519.length + rawPriv.length)
  pkcs8.set(PKCS8_ALG_ID_X25519, 0)
  pkcs8.set(rawPriv, PKCS8_ALG_ID_X25519.length)
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "X25519" }, false, ["deriveBits"])
}

describe("SPIKE: X25519 CryptoKey through IndexedDB", () => {
  it("reports environment + extractability baseline", async () => {
    const pair = await generateKeyPair()
    // eslint-disable-next-line no-console
    console.log("[spike] privateKey.extractable =", pair.privateKey.extractable)
    // eslint-disable-next-line no-console
    console.log("[spike] privateKey.algorithm =", JSON.stringify(pair.privateKey.algorithm))
    // eslint-disable-next-line no-console
    console.log("[spike] privateKey.usages =", JSON.stringify(pair.privateKey.usages))
    expect(pair.privateKey).toBeInstanceOf(CryptoKey)
  })

  it("round-trips the AS-PRODUCED (extractable) private key through IDB and still opens", async () => {
    const pair = await generateKeyPair()
    const pub = await exportPublicKey(pair.publicKey)
    const recipientPublicKey = await (await import("@threa/crypto")).importRecipientPublicKey(pub)

    const sealed = await seal({ recipientPublicKey, plaintext: new TextEncoder().encode("hello-spike") })

    const restored = await putAndGet(pair.privateKey)
    // eslint-disable-next-line no-console
    console.log("[spike] restored is CryptoKey =", restored instanceof CryptoKey)
    expect(restored).toBeInstanceOf(CryptoKey)

    const out = await open({ recipientPrivateKey: restored, enc: sealed.enc, ct: sealed.ct })
    expect(new TextDecoder().decode(out)).toBe("hello-spike")
  })

  it("round-trips a NON-EXTRACTABLE private key through IDB and still opens", async () => {
    const pair = await generateKeyPair()
    const pub = await exportPublicKey(pair.publicKey)
    const rawPriv = await exportPrivateKey(pair.privateKey)
    const recipientPublicKey = await (await import("@threa/crypto")).importRecipientPublicKey(pub)

    const nonExtractable = await importNonExtractablePrivate(rawPriv)
    // eslint-disable-next-line no-console
    console.log("[spike] nonExtractable.extractable =", nonExtractable.extractable)
    expect(nonExtractable.extractable).toBe(false)

    const sealed = await seal({ recipientPublicKey, plaintext: new TextEncoder().encode("non-extractable-spike") })

    const restored = await putAndGet(nonExtractable)
    expect(restored).toBeInstanceOf(CryptoKey)
    // eslint-disable-next-line no-console
    console.log("[spike] restored.extractable =", restored.extractable)
    expect(restored.extractable).toBe(false)

    const out = await open({ recipientPrivateKey: restored, enc: sealed.enc, ct: sealed.ct })
    expect(new TextDecoder().decode(out)).toBe("non-extractable-spike")
  })

  it("confirms a restored non-extractable key cannot be exported", async () => {
    const pair = await generateKeyPair()
    const rawPriv = await exportPrivateKey(pair.privateKey)
    const nonExtractable = await importNonExtractablePrivate(rawPriv)
    const restored = await putAndGet(nonExtractable)
    await expect(crypto.subtle.exportKey("pkcs8", restored)).rejects.toThrow()
    await expect(importRecipientPrivateKey(rawPriv)).resolves.toBeInstanceOf(CryptoKey)
  })
})
