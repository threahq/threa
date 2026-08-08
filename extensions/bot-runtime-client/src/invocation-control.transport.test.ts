import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import * as socketIoClient from "socket.io-client"
import {
  buildMessageAad,
  buildWrapAad,
  bytesToBase64,
  exportPublicKey,
  generateKeyPair,
  generateStreamKey,
  importRecipientPublicKey,
  sealMessage,
  serializeSealedPayload,
  wrapStreamKey,
  type AttachmentRef,
} from "./crypto"
import type { InvocationControlScheduler, ObserveClaimParams } from "./invocation-control"
import { BotRuntimeTransport } from "./transport"
import type { BotRuntimeTransportOptions } from "./types"

const HELLO = {
  instanceId: "inst_1",
  runtimeKind: "test-runtime",
  supportedCapabilities: [],
}
const originalFetch = global.fetch
const spies: { mockRestore(): void }[] = []

afterEach(() => {
  global.fetch = originalFetch
  for (const spy of spies.splice(0)) spy.mockRestore()
})

interface RequestRecord {
  url: string
  body?: Record<string, unknown>
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } })
}

function stubFetch(responder: (request: RequestRecord) => Response | Promise<Response>): RequestRecord[] {
  const requests: RequestRecord[] = []
  global.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const request = {
      url: typeof input === "string" ? input : input.toString(),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    }
    requests.push(request)
    return responder(request)
  }) as unknown as typeof fetch
  return requests
}

function makeTransport(overrides: Partial<BotRuntimeTransportOptions> = {}) {
  return new BotRuntimeTransport({
    baseUrl: "https://app.example.test",
    workspaceId: "ws_1",
    apiKey: "threa_bk_test",
    hello: HELLO,
    controlRetryDelayMs: 5,
    controlMinRenewDelayMs: 2,
    wsAckTimeoutMs: 10,
    fetchTimeoutMs: 20,
    ...overrides,
  })
}

function observation(
  onInputUpdated: ObserveClaimParams["callbacks"]["onInputUpdated"],
  onCancelled: ObserveClaimParams["callbacks"]["onCancelled"] = () => {},
  invocationId = "binv_1"
): ObserveClaimParams {
  return {
    invocationId,
    sourceMessageId: `msg_${invocationId}`,
    claimToken: `token_${invocationId}`,
    sourceRevision: 2,
    claimTtlSeconds: 60,
    callbacks: { onInputUpdated, onCancelled },
  }
}

function active(invocationId: string, revision: number, update?: unknown) {
  return {
    data: {
      invocationId,
      status: "active",
      claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      sourceRevision: revision,
      ...(update === undefined ? {} : { update }),
    },
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 400): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out")
    await Bun.sleep(1)
  }
}

class FakeScheduler implements InvocationControlScheduler {
  private nowMs = 0
  private nextId = 1
  private readonly tasks = new Map<number, { at: number; callback: () => void }>()
  private fired = 0

  get pendingCount(): number {
    return this.tasks.size
  }

  get firedCount(): number {
    return this.fired
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++
    this.tasks.set(id, { at: this.nowMs + delayMs, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.tasks.delete(handle as number)
  }

  advanceBy(ms: number): void {
    const target = this.nowMs + ms
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0]
      if (!next) break
      this.nowMs = next[1].at
      this.tasks.delete(next[0])
      this.fired++
      next[1].callback()
    }
    this.nowMs = target
  }
}

interface FakeSocket {
  handlers: Record<string, (...args: unknown[]) => void>
  timeout: () => { emit: (...args: unknown[]) => void }
  emit: (...args: unknown[]) => void
  on: (event: string, callback: (...args: unknown[]) => void) => FakeSocket
  connect: ReturnType<typeof mock>
  disconnect: ReturnType<typeof mock>
  removeAllListeners: ReturnType<typeof mock>
}

function fakeSocket(
  responder: (event: string, payload: unknown, callback: (error: unknown, ack?: unknown) => void) => void
): FakeSocket {
  const socket: FakeSocket = {
    handlers: {},
    connect: mock(() => {}),
    disconnect: mock(() => {}),
    removeAllListeners: mock(() => {}),
    on(event, callback) {
      socket.handlers[event] = callback
      return socket
    },
    emit: (...args) => responder(args[0] as string, args[1], args.at(-1) as (error: unknown, ack?: unknown) => void),
    timeout: () => ({ emit: (...args) => socket.emit(...args) }),
  }
  return socket
}

function attachReadySocket(transport: BotRuntimeTransport, socket: FakeSocket): void {
  const mutable = transport as unknown as { socket: unknown; connected: boolean; helloReady: boolean }
  mutable.socket = socket
  mutable.connected = true
  mutable.helloReady = true
}

function spySocket(socket: FakeSocket): void {
  spies.push(spyOn(socketIoClient, "io").mockReturnValue(socket as unknown as ReturnType<typeof socketIoClient.io>))
}

describe("BotRuntimeTransport observed claims", () => {
  it("dead socket recovers an update over HTTP and legacy renew remains compatible", async () => {
    const requests = stubFetch((request) =>
      request.url.includes("/renew")
        ? json(
            active("binv_1", 3, {
              delivery: "plaintext",
              sourceRevision: 3,
              promptMarkdown: "latest",
              mentionedActorSlugs: [],
            })
          )
        : json({})
    )
    const updates: string[] = []
    const transport = makeTransport()
    const handle = transport.observeClaim(observation((update) => (updates.push(update.promptMarkdown), "applied")))
    await waitFor(() => handle.currentRevision === 3)

    expect(updates).toEqual(["latest"])
    expect(await transport.renewClaim("binv_legacy", "legacy_token", 60)).toEqual({ notFound: false })
    expect(requests.filter((request) => request.url.includes("/renew")).map((request) => request.body)).toEqual([
      {
        instanceId: "inst_1",
        claimToken: "token_binv_1",
        claimTtlSeconds: 60,
        knownSourceRevision: 2,
      },
      { instanceId: "inst_1", claimToken: "legacy_token", claimTtlSeconds: 60 },
    ])
    transport.disconnect()
  })

  it("sends restart known=N/restart=N, retries transient HTTP failure, and normalizes backend reason", async () => {
    let renew = 0
    const requests = stubFetch((request) => {
      if (!request.url.includes("/renew")) return json({})
      renew++
      if (renew === 1) {
        return json(
          active("binv_1", 3, {
            delivery: "plaintext",
            sourceRevision: 3,
            promptMarkdown: "three",
            mentionedActorSlugs: [],
          })
        )
      }
      if (renew === 2) return json({ error: "retry" }, 503)
      return json({
        data: {
          invocationId: "binv_1",
          status: "cancelled",
          sourceRevision: 3,
          reason: "adapter_restart_required",
        },
      })
    })
    const updates = mock(() => "restart-required" as const)
    const cancellations: unknown[] = []
    const transport = makeTransport()
    transport.observeClaim(observation(updates, (value) => void cancellations.push(value)))

    await waitFor(() => cancellations.length === 1)

    expect(requests.filter((request) => request.url.includes("/renew")).map((request) => request.body)).toEqual([
      {
        instanceId: "inst_1",
        claimToken: "token_binv_1",
        claimTtlSeconds: 60,
        knownSourceRevision: 2,
      },
      {
        instanceId: "inst_1",
        claimToken: "token_binv_1",
        claimTtlSeconds: 60,
        knownSourceRevision: 3,
        restartRequiredRevision: 3,
      },
      {
        instanceId: "inst_1",
        claimToken: "token_binv_1",
        claimTtlSeconds: 60,
        knownSourceRevision: 3,
        restartRequiredRevision: 3,
      },
    ])
    expect({ updateCalls: updates.mock.calls.length, cancellations }).toEqual({
      updateCalls: 1,
      cancellations: [{ invocationId: "binv_1", sourceRevision: 3, reason: "input_restart" }],
    })
    transport.disconnect()
  })

  it("probes current authority after stale restart 404 and restarts revision 4 exactly once", async () => {
    let renew = 0
    const requests = stubFetch((request) => {
      if (!request.url.includes("/renew")) return json({})
      renew++
      if (renew === 1) {
        return json(
          active("binv_1", 3, {
            delivery: "plaintext",
            sourceRevision: 3,
            promptMarkdown: "three",
          })
        )
      }
      if (renew === 2) return new Response(null, { status: 404 })
      if (renew === 3) {
        return json(
          active("binv_1", 4, {
            delivery: "plaintext",
            sourceRevision: 4,
            promptMarkdown: "four",
          })
        )
      }
      return json({
        data: {
          invocationId: "binv_1",
          status: "cancelled",
          sourceRevision: 4,
          reason: "adapter_restart_required",
        },
      })
    })
    const updates: number[] = []
    const cancellations: unknown[] = []
    const transport = makeTransport()
    transport.observeClaim(
      observation(
        (update) => (updates.push(update.sourceRevision), "restart-required"),
        (cancellation) => void cancellations.push(cancellation)
      )
    )

    await waitFor(() => cancellations.length === 1)

    expect(requests.filter((request) => request.url.includes("/renew")).map((request) => request.body)).toEqual([
      {
        instanceId: "inst_1",
        claimToken: "token_binv_1",
        claimTtlSeconds: 60,
        knownSourceRevision: 2,
      },
      {
        instanceId: "inst_1",
        claimToken: "token_binv_1",
        claimTtlSeconds: 60,
        knownSourceRevision: 3,
        restartRequiredRevision: 3,
      },
      {
        instanceId: "inst_1",
        claimToken: "token_binv_1",
        claimTtlSeconds: 60,
        knownSourceRevision: 2,
      },
      {
        instanceId: "inst_1",
        claimToken: "token_binv_1",
        claimTtlSeconds: 60,
        knownSourceRevision: 4,
        restartRequiredRevision: 4,
      },
    ])
    expect({ updates, cancellations }).toEqual({
      updates: [3, 4],
      cancellations: [{ invocationId: "binv_1", sourceRevision: 4, reason: "input_restart" }],
    })
    transport.disconnect()
  })

  it("restart 404 followed by normal 404 terminalizes without invented cancellation or polling", async () => {
    const scheduler = new FakeScheduler()
    let renew = 0
    const requests = stubFetch((request) => {
      if (!request.url.includes("/renew")) return json({})
      renew++
      return renew === 1
        ? json(
            active("binv_1", 3, {
              delivery: "plaintext",
              sourceRevision: 3,
              promptMarkdown: "three",
            })
          )
        : new Response(null, { status: 404 })
    })
    const updates = mock(() => "restart-required" as const)
    const cancelled = mock(() => {})
    const transport = makeTransport({ controlScheduler: scheduler })
    transport.observeClaim(observation(updates, cancelled))
    await waitFor(() => requests.filter((request) => request.url.includes("/renew")).length === 3)

    expect(scheduler.pendingCount).toBe(0)
    scheduler.advanceBy(120_000)
    await Promise.resolve()
    await Promise.resolve()

    expect({
      renewCalls: renew,
      updateCalls: updates.mock.calls.length,
      cancellationCalls: cancelled.mock.calls.length,
      pendingTimers: scheduler.pendingCount,
      firedTimers: scheduler.firedCount,
    }).toEqual({
      renewCalls: 3,
      updateCalls: 1,
      cancellationCalls: 0,
      pendingTimers: 0,
      firedTimers: 0,
    })
    transport.disconnect()
  })

  it("WS NOT_FOUND and HTTP 404 terminalize without cancellation or later polls", async () => {
    const httpRequests = stubFetch(() => new Response(null, { status: 404 }))
    const httpCancelled = mock(() => {})
    const httpTransport = makeTransport()
    httpTransport.observeClaim(observation(() => "applied", httpCancelled, "binv_http"))
    await waitFor(() => httpRequests.length === 1)

    const wsCancelled = mock(() => {})
    const socket = fakeSocket((_event, _payload, callback) => callback(null, { ok: false, code: "NOT_FOUND" }))
    const wsTransport = makeTransport()
    attachReadySocket(wsTransport, socket)
    wsTransport.observeClaim(observation(() => "applied", wsCancelled, "binv_ws"))
    await Bun.sleep(15)

    expect({
      httpCalls: httpRequests.length,
      httpCancelled: httpCancelled.mock.calls.length,
      wsCancelled: wsCancelled.mock.calls.length,
    }).toEqual({
      httpCalls: 1,
      httpCancelled: 0,
      wsCancelled: 0,
    })
    httpTransport.disconnect()
    wsTransport.disconnect()
  })

  it("rejects cross-invocation, mismatched, negative, and stale cancellation states", async () => {
    const responses = [
      active("binv_other", 3, { delivery: "plaintext", sourceRevision: 3, promptMarkdown: "cross" }),
      active("binv_1", 4, { delivery: "plaintext", sourceRevision: 3, promptMarkdown: "mismatch" }),
      {
        data: {
          invocationId: "binv_1",
          status: "active",
          claimExpiresAt: new Date().toISOString(),
          sourceRevision: -1,
        },
      },
      { data: { invocationId: "binv_1", status: "cancelled", sourceRevision: 1, reason: "source_deleted" } },
      active("binv_1", 3, { delivery: "plaintext", sourceRevision: 3, promptMarkdown: "valid" }),
    ]
    const requests = stubFetch(() => json(responses.shift()))
    const updates: string[] = []
    const cancelled = mock(() => {})
    const transport = makeTransport({ controlRetryDelayMs: 1_000 })
    const handle = transport.observeClaim(
      observation((update) => (updates.push(update.promptMarkdown), "applied"), cancelled)
    )

    await waitFor(() => requests.length === 1)
    while (requests.length < 5) {
      const previous = requests.length
      await handle.sync()
      await waitFor(() => requests.length > previous)
    }
    await waitFor(() => handle.currentRevision === 3)

    expect({ updates, cancellationCalls: cancelled.mock.calls.length, revision: handle.currentRevision }).toEqual({
      updates: ["valid"],
      cancellationCalls: 0,
      revision: 3,
    })
    transport.disconnect()
  })

  it("disconnect clears authoritative renewal timer before its deadline", async () => {
    const scheduler = new FakeScheduler()
    const requests = stubFetch(() => json(active("binv_1", 2)))
    const update = mock(() => "applied" as const)
    const cancelled = mock(() => {})
    const transport = makeTransport({ controlScheduler: scheduler })
    const handle = transport.observeClaim(observation(update, cancelled))
    await handle.sync()

    transport.disconnect()
    expect(scheduler.pendingCount).toBe(0)
    scheduler.advanceBy(120_000)
    await Promise.resolve()
    await Promise.resolve()

    expect({
      networkCalls: requests.length,
      updateCalls: update.mock.calls.length,
      cancellationCalls: cancelled.mock.calls.length,
      pendingTimers: scheduler.pendingCount,
      firedTimers: scheduler.firedCount,
    }).toEqual({
      networkCalls: 1,
      updateCalls: 0,
      cancellationCalls: 0,
      pendingTimers: 0,
      firedTimers: 0,
    })
  })

  it("caps a custom observed-control WS timeout for a 15-second lease", async () => {
    const requests = stubFetch(() => json(active("binv_1", 2)))
    const timeoutBudgets: number[] = []
    const socket = fakeSocket((_event, _payload, callback) => callback(new Error("timeout")))
    socket.timeout = (timeoutMs?: unknown) => {
      timeoutBudgets.push(timeoutMs as number)
      return { emit: (...args) => socket.emit(...args) }
    }
    const transport = makeTransport({ wsAckTimeoutMs: 9_000 })
    attachReadySocket(transport, socket)
    const handle = transport.observeClaim({ ...observation(() => "applied"), claimTtlSeconds: 15 })
    await waitFor(() => requests.length === 1)

    expect({ timeoutBudgets, httpCalls: requests.length }).toEqual({ timeoutBudgets: [2_500], httpCalls: 1 })
    handle.unregister()
    transport.disconnect()
  })

  it("unregister/re-register during WS wait aborts old generations before HTTP fallback", async () => {
    const requests = stubFetch(() => json({}))
    const callbacks: ((error: unknown, ack?: unknown) => void)[] = []
    const socket = fakeSocket((_event, _payload, callback) => callbacks.push(callback))
    const transport = makeTransport({ wsAckTimeoutMs: 1_000 })
    attachReadySocket(transport, socket)

    transport.observeClaim(observation(() => "applied"))
    await waitFor(() => callbacks.length === 1)
    const replacement = transport.observeClaim(observation(() => "applied"))
    await waitFor(() => callbacks.length === 2)
    replacement.unregister()
    callbacks[0]!(new Error("late timeout"))
    callbacks[1]!(new Error("late timeout"))
    await Bun.sleep(5)

    expect(requests).toEqual([])
    transport.disconnect()
  })

  it("hello recovers update and cancellation before bootstrap/availability and filters malformed entries", async () => {
    const order: string[] = []
    let connected = false
    stubFetch((request) => {
      if (request.url.endsWith("/config")) return json({ wsUrl: "https://ws.example.test" })
      return json(active(request.url.includes("binv_2") ? "binv_2" : "binv_1", 2))
    })
    const socket = fakeSocket((event, payload, callback) => {
      if (event === "bot:hello") {
        callback(null, {
          ok: true,
          serverGeneratedAt: "2026-08-01T00:00:00.000Z",
          availableInvocations: [{ arbitrary: true }],
          ownedClaims: [{ id: 42, sourceRevision: -1 }],
          recentCancellations: [
            { invocationId: "binv_2", sourceRevision: 3, reason: "adapter_restart_required" },
            { invocationId: 42, sourceRevision: -1, reason: "bad" },
          ],
        })
        return
      }
      const id = (payload as { invocationId: string }).invocationId
      if (id === "binv_1") {
        callback(null, {
          ok: true,
          data: active("binv_1", 3, {
            delivery: "plaintext",
            sourceRevision: 3,
            promptMarkdown: "recovered",
          }).data,
        })
      } else {
        callback(null, { ok: true, data: active("binv_2", 2).data })
      }
    })
    spySocket(socket)
    const bootstraps: unknown[] = []
    const transport = makeTransport({
      callbacks: {
        onBootstrap: (bootstrap) => {
          order.push("bootstrap")
          bootstraps.push(bootstrap)
        },
        onInvocationAvailable: () => order.push("available"),
      },
    })
    transport.observeClaim(
      observation(
        () => (order.push("update"), "applied"),
        () => {},
        "binv_1"
      )
    )
    transport.observeClaim(
      observation(
        () => "applied",
        () => void order.push("cancel"),
        "binv_2"
      )
    )
    await Bun.sleep(0)

    await transport.connect()
    connected = true
    socket.handlers.connect!()
    socket.handlers["bot_invocation:available"]!()
    await waitFor(() => order.includes("available"))

    expect(connected).toBe(true)
    expect(order.indexOf("update")).toBeLessThan(order.indexOf("bootstrap"))
    expect(order.indexOf("cancel")).toBeLessThan(order.indexOf("bootstrap"))
    expect(order.indexOf("update")).toBeLessThan(order.indexOf("available"))
    expect(bootstraps).toEqual([
      {
        serverGeneratedAt: "2026-08-01T00:00:00.000Z",
        availableInvocations: [{ arbitrary: true }],
        ownedClaims: [],
        recentCancellations: [{ invocationId: "binv_2", sourceRevision: 3, reason: "input_restart" }],
      },
    ])
    transport.disconnect()
  })

  it("handles live WS update and cancellation hints with authoritative metadata-only sync", async () => {
    stubFetch((request) => (request.url.endsWith("/config") ? json({ wsUrl: "https://ws.example.test" }) : json({})))
    let renewCalls = 0
    const socket = fakeSocket((event, _payload, callback) => {
      if (event === "bot:hello") {
        callback(null, { ok: true, ownedClaims: [], recentCancellations: [], availableInvocations: [] })
        return
      }
      renewCalls++
      callback(null, {
        ok: true,
        data:
          renewCalls === 1
            ? active("binv_1", 2).data
            : active("binv_1", 3, {
                delivery: "plaintext",
                sourceRevision: 3,
                promptMarkdown: "from authority",
              }).data,
      })
    })
    spySocket(socket)
    const updates: string[] = []
    const cancellations: unknown[] = []
    const transport = makeTransport()
    await transport.connect()
    socket.handlers.connect!()
    const handle = transport.observeClaim(
      observation(
        (update) => (updates.push(update.promptMarkdown), "applied"),
        (cancellation) => void cancellations.push(cancellation)
      )
    )
    await waitFor(() => renewCalls === 1)

    socket.handlers["bot_invocation:input_updated"]!({
      invocationId: "binv_1",
      sourceRevision: 3,
      promptMarkdown: "untrusted hint content",
    })
    await waitFor(() => handle.currentRevision === 3)
    socket.handlers["bot_invocation:cancelled"]!({
      invocationId: "binv_1",
      sourceRevision: 3,
      reason: "source_deleted",
    })
    await waitFor(() => cancellations.length === 1)
    await Bun.sleep(10)

    expect({ updates, cancellations, renewCalls }).toEqual({
      updates: ["from authority"],
      cancellations: [{ invocationId: "binv_1", sourceRevision: 3, reason: "source_deleted" }],
      renewCalls: 2,
    })
    transport.disconnect()
  })

  it("opens a sealed key-roll delta with attachment refs and replacement sealing state", async () => {
    const keyPair = await generateKeyPair()
    const publicKeyBase64 = bytesToBase64(await exportPublicKey(keyPair.publicKey))
    const identity = { publicKeyId: "bik_1", publicKeyBase64, privateKey: keyPair.privateKey }
    const streamId = "stream_root"
    const ssk = generateStreamKey()
    const recipient = await importRecipientPublicKey(await exportPublicKey(keyPair.publicKey))
    const wrapped = await wrapStreamKey({
      key: ssk,
      recipientPublicKey: recipient,
      aad: buildWrapAad({ streamId, keyGeneration: 2, recipientKeyId: identity.publicKeyId }),
    })
    const attachment: AttachmentRef = {
      attachmentId: "att_1",
      key: "file_key",
      iv: "file_iv",
      filename: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    }
    const prompt = await sealMessage({
      key: ssk,
      keyGeneration: 2,
      payload: serializeSealedPayload("sealed latest", { attachmentRefs: [attachment] }),
      aad: buildMessageAad({ streamId, messageId: "msg_binv_1", senderId: "usr_1" }),
    })
    stubFetch(() =>
      json(
        active("binv_1", 3, {
          delivery: "sealed",
          sourceRevision: 3,
          prompt: { ciphertext: bytesToBase64(prompt.ciphertext), envelope: prompt.envelope },
          wraps: [
            {
              keyGeneration: 2,
              wrapEnc: bytesToBase64(wrapped.enc),
              wrapCt: bytesToBase64(wrapped.ct),
            },
          ],
          reply: { keyGeneration: 2, senderId: "bot_1" },
        })
      )
    )
    const updates: unknown[] = []
    const transport = makeTransport()
    const handle = transport.observeClaim({
      ...observation((update) => (updates.push(update), "applied")),
      sealed: { identity, streamId, callbackToken: "callback_secret" },
    })
    await waitFor(() => handle.currentRevision === 3)

    expect(updates).toEqual([
      expect.objectContaining({
        delivery: "sealed",
        promptMarkdown: "sealed latest",
        attachmentRefs: [attachment],
        sealing: expect.objectContaining({ replyKeyGeneration: 2, callbackToken: "callback_secret" }),
      }),
    ])
    expect(handle.sealing).toEqual(expect.objectContaining({ replyKeyGeneration: 2, callbackToken: "callback_secret" }))
    transport.disconnect()
  })

  it("wrong sealed key logs only bounded class/ID and requests restart without callback", async () => {
    let calls = 0
    const logs: string[] = []
    const requests = stubFetch((request) => {
      calls++
      if (calls > 1) return json({ error: "retry" }, 503)
      return json(
        active("binv_1", 3, {
          delivery: "sealed",
          sourceRevision: 3,
          prompt: {
            ciphertext: bytesToBase64(new Uint8Array([1, 2, 3])),
            envelope: { v: 2, keyGeneration: 2, iv: "secret_iv", aad: "secret_aad" },
          },
          wraps: [{ keyGeneration: 2, wrapEnc: "secret_wrap", wrapCt: "secret_ct" }],
          reply: { keyGeneration: 2, senderId: "bot_1" },
        })
      )
    })
    const identity = {
      publicKeyId: "bik_1",
      publicKeyBase64: "public",
      privateKey: (await generateKeyPair()).privateKey,
    }
    const callback = mock(() => "applied" as const)
    const transport = makeTransport({ log: (message) => logs.push(message), controlRetryDelayMs: 1_000 })
    const handle = transport.observeClaim({
      ...observation(callback),
      sealed: { identity, streamId: "stream_root", callbackToken: "callback_secret" },
    })
    await waitFor(() => requests.some((request) => request.body?.restartRequiredRevision === 3))

    expect({ callbackCalls: callback.mock.calls.length, restart: requests.at(-1)?.body, logs }).toEqual({
      callbackCalls: 0,
      restart: {
        instanceId: "inst_1",
        claimToken: "token_binv_1",
        claimTtlSeconds: 60,
        knownSourceRevision: 3,
        restartRequiredRevision: 3,
      },
      logs: ["sealed invocation update failed (binv_1): Error"],
    })
    expect(logs.join(" ")).not.toContain("secret_")
    handle.unregister()
    transport.disconnect()
  })
})
