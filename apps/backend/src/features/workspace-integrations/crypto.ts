import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "crypto"
import type { WorkspaceIntegrationProvider } from "@threahq/types"
export { extractWorkspaceIdFromGithubInstallState } from "@threahq/backend-common"

const ENCRYPTION_VERSION = 2
const GCM_ALGORITHM = "aes-256-gcm"
const IV_LENGTH_BYTES = 12
// Bounds replay if a state value leaks (referer, history, logs) while still
// covering the GitHub install flow, including org admin approval.
const MAX_STATE_AGE_MS = 10 * 60 * 1000

export interface EncryptedJsonPayload extends Record<string, unknown> {
  v: number
  iv: string
  tag: string
  ciphertext: string
}

export interface EncryptionContext {
  workspaceId: string
  provider: WorkspaceIntegrationProvider
}

function deriveKey(secret: string, version: number): Buffer {
  return createHmac("sha256", secret).update(`workspace-integration-credentials:v${version}`).digest()
}

function buildEncryptionContextAAD(context: EncryptionContext): Buffer {
  return Buffer.from(JSON.stringify([context.workspaceId, context.provider]), "utf8")
}

export function encryptJson(secret: string, value: unknown, context: EncryptionContext): EncryptedJsonPayload {
  const iv = randomBytes(IV_LENGTH_BYTES)
  const key = deriveKey(secret, ENCRYPTION_VERSION)
  const cipher = createCipheriv(GCM_ALGORITHM, key, iv)
  cipher.setAAD(buildEncryptionContextAAD(context))
  const plaintext = Buffer.from(JSON.stringify(value), "utf8")
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()

  return {
    v: ENCRYPTION_VERSION,
    iv: iv.toString("base64url"),
    tag: tag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  }
}

export function decryptJson<T>(secret: string, payload: Record<string, unknown>, context: EncryptionContext): T {
  const iv = payload.iv
  const tag = payload.tag
  const ciphertext = payload.ciphertext
  const version = payload.v

  if (
    version !== ENCRYPTION_VERSION ||
    typeof iv !== "string" ||
    typeof tag !== "string" ||
    typeof ciphertext !== "string"
  ) {
    throw new Error("Invalid encrypted workspace integration payload")
  }

  const key = deriveKey(secret, version)
  const decipher = createDecipheriv(GCM_ALGORITHM, key, Buffer.from(iv, "base64url"))
  decipher.setAAD(buildEncryptionContextAAD(context))
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(
    "utf8"
  )

  return JSON.parse(plaintext) as T
}

function signStatePayload(secret: string, domain: string, payload: string): string {
  return createHmac("sha256", secret).update(`${domain}:${payload}`).digest("hex")
}

function createInstallState(secret: string, domain: string, workspaceId: string, nowMs: number): string {
  const payload = `${workspaceId}.${nowMs}`
  return `${payload}.${signStatePayload(secret, domain, payload)}`
}

function verifyInstallState(
  secret: string,
  domain: string,
  providerLabel: string,
  state: string,
  nowMs: number
): { workspaceId: string } {
  const [workspaceId, issuedAtRaw, signature] = state.split(".")
  if (!workspaceId || !issuedAtRaw || !signature) {
    throw new Error(`Malformed ${providerLabel} install state`)
  }

  const payload = `${workspaceId}.${issuedAtRaw}`
  const expectedSignature = signStatePayload(secret, domain, payload)
  const expectedBuffer = Buffer.from(expectedSignature, "utf8")
  const providedBuffer = Buffer.from(signature, "utf8")
  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    throw new Error(`Invalid ${providerLabel} install state signature`)
  }

  const issuedAtMs = Number.parseInt(issuedAtRaw, 10)
  if (!Number.isFinite(issuedAtMs)) {
    throw new Error(`Malformed ${providerLabel} install state timestamp`)
  }

  if (nowMs - issuedAtMs > MAX_STATE_AGE_MS) {
    throw new Error(`${providerLabel} install state has expired`)
  }

  return { workspaceId }
}

const GITHUB_STATE_DOMAIN = "github-install-state"
const LINEAR_STATE_DOMAIN = "linear-install-state"

export function createGithubInstallState(secret: string, workspaceId: string, nowMs = Date.now()): string {
  return createInstallState(secret, GITHUB_STATE_DOMAIN, workspaceId, nowMs)
}

export function verifyGithubInstallState(secret: string, state: string, nowMs = Date.now()): { workspaceId: string } {
  return verifyInstallState(secret, GITHUB_STATE_DOMAIN, "GitHub", state, nowMs)
}

export function createLinearInstallState(secret: string, workspaceId: string, nowMs = Date.now()): string {
  return createInstallState(secret, LINEAR_STATE_DOMAIN, workspaceId, nowMs)
}

export function verifyLinearInstallState(secret: string, state: string, nowMs = Date.now()): { workspaceId: string } {
  return verifyInstallState(secret, LINEAR_STATE_DOMAIN, "Linear", state, nowMs)
}
