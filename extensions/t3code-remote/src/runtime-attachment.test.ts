import { expect, test } from "bun:test"
import { RemoteSession, ThreaClient, type RuntimeOriginClaimedInvocation } from "@threahq/remote-session"
import { T3CODE_RUNTIME, T3TurnRunner } from "./run-bridge"
import { fakeT3, item, until } from "./t3.test-support"

type Transport = NonNullable<ConstructorParameters<typeof RemoteSession>[0]["transport"]>

test("should trace and complete a native run through the real SDK without delegate input", async () => {
  const t3 = fakeT3()
  const messages: Array<{ id: string; body: Record<string, unknown> }> = []
  const completions: Array<{ id: string; body: Record<string, unknown> }> = []
  const traces: Array<{ id: string; frames: unknown[] }> = []
  const invocation: RuntimeOriginClaimedInvocation = {
    id: "binv_native",
    workspaceId: "ws_test",
    rootStreamId: "stream_root",
    activeStreamId: "stream_root",
    sourceMessageId: null,
    sourceRevision: 0,
    responseStreamId: "stream_root",
    actor: { type: "bot", id: "bot_test", slug: "t3" },
    trigger: "runtime-origin",
    requiredCapability: "active-scratchpad",
    promptMarkdown: "",
    authorUserId: "usr_test",
    mentionedActorSlugs: [],
    claimToken: "claim_test",
    claimExpiresAt: "2099-01-01T00:00:00.000Z",
    runtimeSessionId: "rts_test",
    metadata: {},
  }
  const client = {
    adoptRuntimeRun: async () => ({ status: "claimed", invocation }),
    claim: async () => null,
    getStream: async () => ({ e2eEnabled: false, archivedAt: null }),
    sendInvocationMessage: async (id: string, body: Record<string, unknown>) => {
      messages.push({ id, body })
    },
    complete: async (id: string, body: Record<string, unknown>) => {
      completions.push({ id, body })
    },
    fail: async () => {
      throw new Error("unexpected failure")
    },
  } as unknown as ThreaClient
  const transport = {
    socketConnected: false,
    connect: async () => {},
    disconnect: () => {},
    sendHello: () => {},
    updatePresence: async () => {},
    recordSteps: async (id: string, _token: string, frames: unknown[]) => {
      traces.push({ id, frames })
      return true
    },
    observeClaim: (_params: Parameters<Transport["observeClaim"]>[0]) => ({
      sync: async () => {},
      unregister: () => {},
      dispose: () => {},
    }),
  } as unknown as Transport
  let deliveries = 0
  const session = new RemoteSession({
    config: {
      baseUrl: "https://example.test",
      workspaceId: "ws_test",
      apiKey: "synthetic",
      displayName: "Test",
      instanceId: "test",
      runtimeSessionId: "rts_test",
      permissionRelay: false,
      pollMs: 3000,
      idleTimeoutMs: 3600000,
      keyScope: "host",
      sealedFullTrace: false,
      traceMode: "commands",
    },
    client,
    transport,
    runtime: T3CODE_RUNTIME,
    delegate: {
      deliverTurn: async () => {
        deliveries++
      },
    },
  })
  Object.assign(session, { link: { rootStreamId: "stream_root" } })
  const runner = new T3TurnRunner({
    client: t3.client,
    session: {
      get rootStreamId() {
        return session.rootStreamId
      },
      adoptRuntimeRun: (input) => session.adoptRuntimeRun(input),
      postToInvocation: (id, body) => session.postToInvocation(id, body),
      endTurn: (id, text) => session.endTurn(id, text),
      recordSteps: (id, frames, status) => session.recordSteps(id, frames, status),
      reply: (id, text) => session.reply(id, text),
      sendInterim: (id, text) => session.sendInterim(id, text),
      failTurn: (id, error) => session.failTurn(id, error),
      requestDecision: (input, options) => session.requestDecision(input, options),
      isEncrypted: async () => false,
    },
    access: "full-access",
    traceMode: "commands",
    sealedFullTrace: false,
    threadStore: { load: () => ({ threads: { stream_root: "thread_1" } }), save: () => {} },
  })
  try {
    t3.startInT3("thread_1")
    await runner.attach("stream_root")
    t3.script("run_1", [
      {
        status: "completed",
        items: [
          item(1, "command_execution", { text: "$ bun test\npassed" }),
          item(2, "assistant_message", { text: "Done." }),
        ],
      },
    ])
    await until(() => !runner.busy)
    expect({
      deliveries,
      nativeWrites: t3.calls.filter(({ name }) => /send|launch|interrupt/.test(name)),
      messages: messages.map(({ id, body }) => ({ id, content: body.content, clientMessageId: body.clientMessageId })),
      completed: completions.map(({ id }) => id),
      traced: traces.flatMap(({ frames }) => frames),
    }).toMatchObject({
      deliveries: 0,
      nativeWrites: [],
      messages: [{ id: "binv_native", content: "Done.", clientMessageId: "t3run-run_1" }],
      completed: ["binv_native"],
      traced: [expect.objectContaining({ stepType: "tool_call" })],
    })
  } finally {
    runner.shutdown()
    await session.shutdown()
  }
})
