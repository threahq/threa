import type { AttachmentRef } from "@threahq/bot-runtime-client"

export interface TestInvocation {
  id: string
  activeStreamId: string
  rootStreamId: string
  sourceMessageId: string
  sourceRevision: number
  promptMarkdown: string
  claimToken: string
  claimedInstanceId: string
  claimExpiresAt: string | null
  [key: string]: unknown
}

export function invocation(
  id = "binv_1",
  revision = 1,
  promptMarkdown = "original",
  overrides: Record<string, unknown> = {}
): TestInvocation {
  return {
    id,
    activeStreamId: "stream_1",
    rootStreamId: "stream_1",
    sourceMessageId: `msg_${id}`,
    sourceRevision: revision,
    promptMarkdown,
    claimToken: `claim_${id}`,
    claimedInstanceId: "pi-matrix",
    claimExpiresAt: null,
    ...overrides,
  } as TestInvocation
}

export function sealingState(overrides: Record<string, unknown> = {}) {
  return {
    streamId: "stream_1",
    replyKeyGeneration: 1,
    replySenderId: "bot_1",
    replySsk: new Uint8Array(32),
    callbackToken: "callback",
    ...overrides,
  }
}

export function attachmentRef(
  attachmentId: string,
  encrypted: { key: string; iv: string },
  overrides: Partial<AttachmentRef> = {}
): AttachmentRef {
  return {
    attachmentId,
    key: encrypted.key,
    iv: encrypted.iv,
    filename: `${attachmentId}.txt`,
    mimeType: "text/plain",
    sizeBytes: 1,
    ...overrides,
  }
}
