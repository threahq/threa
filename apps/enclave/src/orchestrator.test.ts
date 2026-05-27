import { describe, expect, it } from "bun:test"
import {
  buildMessageAad,
  decryptPayloadAsString,
  encryptPayload,
  ENVELOPE_VERSION,
  exportPrivateKey,
  exportPublicKey,
  generateKeyPair,
  importRecipientPrivateKey,
} from "@threa/crypto"
import { AgentToolNames } from "@threa/types"
import type { EnclaveConfig } from "./config"
import type { EnclaveKeyPair } from "./keystore"
import { Orchestrator, type AIFactory, type InvokeRequest } from "./orchestrator"

async function makeKeyPair(prefix: string): Promise<{
  keyId: string
  publicKey: Uint8Array
  privateKey: CryptoKey
  privateKeyBytes: Uint8Array
}> {
  const pair = await generateKeyPair()
  const publicKey = await exportPublicKey(pair.publicKey)
  const privateKeyBytes = await exportPrivateKey(pair.privateKey)
  return {
    keyId: `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
    publicKey,
    privateKey: pair.privateKey,
    privateKeyBytes,
  }
}

function stubAIFactory(replyText: string): AIFactory {
  return ({ costRecorder }) => {
    return {
      getLanguageModel: () => ({}) as any,
      getEmbeddingModel: () => ({}) as any,
      getLangChainModel: async () => ({}) as any,
      parseModel: () => ({ provider: "test", modelId: "test/m", modelProvider: "test", modelName: "m" }),
      costTracker: {} as any,
      generateText: async () => ({}) as any,
      generateObject: async () => ({}) as any,
      embed: async () => ({}) as any,
      embedMany: async () => ({}) as any,
      generateTextWithTools: async () => {
        await costRecorder.recordUsage({
          workspaceId: "enclave",
          functionId: "enclave-agent-loop",
          model: "openrouter:anthropic/claude-sonnet-4.6",
          provider: "openrouter",
          origin: "system",
          usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18, cost: 0.0023 },
        })
        return {
          text: "",
          toolCalls: [
            {
              toolCallId: "tool_send_1",
              toolName: AgentToolNames.SEND_MESSAGE,
              input: { content: replyText },
            },
          ],
          response: {
            messages: [{ role: "assistant", content: replyText } as any],
          },
          usage: { promptTokens: 7, completionTokens: 11, totalTokens: 18, cost: 0.0023 },
        } as any
      },
    }
  }
}

const baseConfig: EnclaveConfig = {
  port: 3011,
  selfUrl: "http://localhost:3011",
  backendBaseUrl: "http://localhost:3001",
  internalApiKey: "test-secret",
  openRouterApiKey: "test-key",
  heartbeatIntervalMs: 30_000,
  allowedPersonaIds: ["persona_system_ariadne"],
}

describe("Orchestrator", () => {
  it("decrypts inbound history, runs the agent loop, and seals the reply to all recipients", async () => {
    const uik = await makeKeyPair("uik")
    const eik = await makeKeyPair("eik")
    const enclaveKeyPair: EnclaveKeyPair = {
      instanceId: "enci_test",
      keyId: eik.keyId,
      publicKey: eik.publicKey,
      publicKeyBase64: Buffer.from(eik.publicKey).toString("base64"),
      privateKey: eik.privateKey,
    }

    const streamId = "stream_test"
    const userMessageId = "msg_user_1"
    const replyMessageId = "msg_reply_1"
    const aad = buildMessageAad({ streamId, messageId: userMessageId, senderId: "usr_owner" })
    const { envelope: userEnvelope } = await encryptPayload({
      payload: "What's on my mind?",
      recipients: [
        { recipientKeyId: uik.keyId, publicKey: uik.publicKey },
        { recipientKeyId: eik.keyId, publicKey: eik.publicKey },
      ],
      aad,
    })

    const orchestrator = new Orchestrator(baseConfig, enclaveKeyPair, stubAIFactory("I'm hearing X about Y."))

    const request: InvokeRequest = {
      invocationId: "inv_1",
      sessionId: "sess_1",
      streamId,
      replyMessageId,
      persona: {
        id: "persona_system_ariadne",
        name: "Ariadne",
        systemPrompt: "You are Ariadne.",
        model: "openrouter:anthropic/claude-sonnet-4.6",
        temperature: 0.7,
        maxTokens: 1024,
        e2eEnabledTools: [],
        currentTime: "2026-05-27T12:00:00Z",
        timezone: "UTC",
      },
      history: [
        {
          id: userMessageId,
          authorId: "usr_owner",
          authorType: "user",
          createdAt: new Date().toISOString(),
          ciphertext: userEnvelope.ciphertext,
          envelope: userEnvelope,
          e2eVersion: ENVELOPE_VERSION,
          sequence: "1",
        },
      ],
      recipients: [
        { recipientKeyId: uik.keyId, publicKey: Buffer.from(uik.publicKey).toString("base64") },
        { recipientKeyId: eik.keyId, publicKey: Buffer.from(eik.publicKey).toString("base64") },
      ],
      aadParts: { streamId, senderId: "persona_system_ariadne" },
    }

    const response = await orchestrator.invoke(request)

    expect(response.sidecar.promptTokens).toBe(7)
    expect(response.sidecar.completionTokens).toBe(11)
    expect(response.sidecar.totalTokens).toBe(18)
    expect(response.sidecar.costUsd).toBeCloseTo(0.0023)
    expect(response.reply.e2eVersion).toBe(ENVELOPE_VERSION)
    expect(response.reply.envelope.recipients).toHaveLength(2)
    expect(response.reply.envelope.recipients.map((r) => r.recipientKeyId).sort()).toEqual(
      [uik.keyId, eik.keyId].sort()
    )

    // Reply envelope must round-trip back to the UIK holder (the user).
    const uikPrivate = await importRecipientPrivateKey(uik.privateKeyBytes)
    const decryptedReply = await decryptPayloadAsString({
      envelope: response.reply.envelope,
      privateKey: uikPrivate,
      recipientKeyId: uik.keyId,
    })
    expect(decryptedReply).toBe("I'm hearing X about Y.")
  })

  it("rejects personas that are not on the enclave allowlist", async () => {
    const eik = await makeKeyPair("eik")
    const enclaveKeyPair: EnclaveKeyPair = {
      instanceId: "enci_test",
      keyId: eik.keyId,
      publicKey: eik.publicKey,
      publicKeyBase64: Buffer.from(eik.publicKey).toString("base64"),
      privateKey: eik.privateKey,
    }
    const orchestrator = new Orchestrator(baseConfig, enclaveKeyPair, stubAIFactory("unused"))

    const request: InvokeRequest = {
      invocationId: "inv_2",
      sessionId: "sess_2",
      streamId: "stream_x",
      replyMessageId: "msg_x",
      persona: {
        id: "persona_disallowed",
        name: "Other",
        systemPrompt: "...",
        model: "openrouter:anthropic/claude-sonnet-4.6",
        temperature: null,
        maxTokens: null,
        e2eEnabledTools: [],
        currentTime: "2026-05-27T12:00:00Z",
        timezone: "UTC",
      },
      history: [],
      recipients: [],
      aadParts: { streamId: "stream_x", senderId: "persona_disallowed" },
    }

    await expect(orchestrator.invoke(request)).rejects.toThrow(/not on the enclave allowlist/)
  })

  it("throws when no history decrypts to a usable message", async () => {
    const eik = await makeKeyPair("eik")
    const enclaveKeyPair: EnclaveKeyPair = {
      instanceId: "enci_test",
      keyId: eik.keyId,
      publicKey: eik.publicKey,
      publicKeyBase64: Buffer.from(eik.publicKey).toString("base64"),
      privateKey: eik.privateKey,
    }
    const orchestrator = new Orchestrator(baseConfig, enclaveKeyPair, stubAIFactory("unused"))

    const request: InvokeRequest = {
      invocationId: "inv_3",
      sessionId: "sess_3",
      streamId: "stream_y",
      replyMessageId: "msg_y",
      persona: {
        id: "persona_system_ariadne",
        name: "Ariadne",
        systemPrompt: "You are Ariadne.",
        model: "openrouter:anthropic/claude-sonnet-4.6",
        temperature: null,
        maxTokens: null,
        e2eEnabledTools: [],
        currentTime: "2026-05-27T12:00:00Z",
        timezone: "UTC",
      },
      history: [],
      recipients: [],
      aadParts: { streamId: "stream_y", senderId: "persona_system_ariadne" },
    }

    await expect(orchestrator.invoke(request)).rejects.toThrow(/empty conversation/)
  })
})
