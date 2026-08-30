# @threahq/bot-runtime-client

Protocol client for Threa's bot runtime. It owns the `/bot` Socket.IO
connection a runtime keeps open to Threa and routes the high-volume writes
(presence, claim renewal, trace steps) over it, falling back to the public HTTP
endpoints when the socket is down. It also carries the sealed-turn crypto an
end-to-end-encrypted bot needs.

Most connectors should use [`@threahq/remote-session`](https://www.npmjs.com/package/@threahq/remote-session),
which builds the whole session loop on top of this package. Use this package
directly when you want the socket and the write routing without the loop, for
example a mention-driven bot that claims work with plain HTTP.

The endpoints and events this package speaks are documented at
[threa.io/developers](https://threa.io/developers): the `Bot runtimes` and
`Bot invocations` sections of the API reference, and the "Connect your local
agent" recipe.

## Install

```sh
npm install @threahq/bot-runtime-client socket.io-client
```

`socket.io-client` is a peer dependency. Node 20+ or Bun.

## Transport

```ts
import { BotRuntimeTransport } from "@threahq/bot-runtime-client"

const transport = new BotRuntimeTransport({
  baseUrl: "https://app.threa.io",
  workspaceId: process.env.THREA_WORKSPACE_ID!,
  apiKey: process.env.THREA_API_KEY!, // a threa_bk_ bot key
  hello: {
    instanceId: "my-laptop-1",
    runtimeKind: "custom",
    supportedCapabilities: ["mentionable"],
  },
  callbacks: {
    onInvocationAvailable: () => drainClaims(),
    onBootstrap: (snapshot) => console.log(snapshot.availableInvocations.length, "claimable"),
  },
  log: (line) => console.error(line),
})

await transport.connect()
await transport.updatePresence({
  runtimeKind: "custom",
  instanceId: "my-laptop-1",
  status: "available",
  acceptingInvocations: true,
  capabilities: {},
})
```

`connect()` resolves the workspace's WebSocket hint from
`GET /api/workspaces/:id/config`, opens the `/bot` namespace with the bot key,
and sends `bot:hello`. The hello ack is the bootstrap snapshot
(`availableInvocations`, `ownedClaims`); `onInvocationAvailable` fires when new
work is claimable. If the hint cannot be resolved, the transport stays HTTP
only and every write goes to the REST endpoint instead. The socket itself is
not required for correctness; it removes the polling.

Three writes are routed:

| Method                          | Socket event           | HTTP fallback                     | Failure policy                                                                   |
| ------------------------------- | ---------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `updatePresence(body)`          | `bot:presence:update`  | `POST /bot-runtime/presence`      | retry over HTTP on any missing ack                                               |
| `renewClaim(id, token, ttl)`    | `bot:invocation:renew` | `POST /bot-invocations/:id/renew` | retry over HTTP on any missing ack; `{ notFound: true }` means the claim is gone |
| `recordSteps(id, token, steps)` | `bot:invocation:steps` | `POST /bot-invocations/:id/steps` | best effort; a frame in flight is not re-sent                                    |

Claiming, completing and failing an invocation are low-frequency writes and
stay on HTTP; `@threahq/remote-session` exposes them as `ThreaClient`.

Server-side rejections arrive as an ack with `ok: false` and a `code`
(`NOT_FOUND`, `FORBIDDEN`, `INVALID_PAYLOAD`, ...). The transport logs them
through `log` and does not throw; a caller that needs the result reads the
return value (`renewClaim`) or checks `socketConnected`.

## Sealed turns

An owner can invite a bot into an end-to-end-encrypted scratchpad. The server
then delivers the claim with a `sealedContext` instead of plaintext, and every
reply and trace step must be ciphertext under the stream key. `BikKeystore`
persists the bot identity key (if the file cannot be read or written, the
session runs on an in-memory key and logs it; scratchpads sealed to that key
are unreadable after a restart), `openSealedTurnContext` decrypts a claim,
`sealReply` and `sealStep` encrypt what goes back, and `recordSealedSteps`
sends sealed frames over the same socket. The wire format is the one the
"Connect an encrypted agent" recipe describes; the SDK handles all of it for
connectors, so only a runtime that bypasses the SDK needs these directly.

## Versioning

The package tracks the current public API version. Threa's REST API is dated
(see the versioning page in the developer docs) and additive within a version,
so a given release of this package keeps working against newer servers.
