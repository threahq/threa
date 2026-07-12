# Public API: Stripe-style header versioning

Status: implemented, PR pending (2026-07-12, see §11). Epoch version `2026-07-12`. Scope: **Phase 1 only** — header versioning on the existing `/api/v1` paths; the bare-path move (Phase 2) is skipped for now. Branch: `feat/reconsider-public-api`.

## TL;DR recommendation

1. **Version via `Threa-Version: YYYY-MM-DD` header**, pinned per API key at mint time, header override per request. Handlers always speak the latest shape; dated **version-change modules** downgrade responses / upgrade requests for older callers. This is Phase 1 and is independent of any URL change.
2. **URL cleanup is severable and optional — and was decided against for now (§11).** Stripe itself never dropped `/v1`; their header versioning coexists with a frozen path prefix, and we do the same. The bare-path design (public at `/api/workspaces/...`, credential-dispatched against the app API, `/api/v1` as a rewriting alias for ≥6 months) is retained in §4/§9 as reference should it be revisited.
3. **Unify the plumbing, not the surface.** One namespace, one principal model, shared services (already true) — but the public surface stays a curated registry with its own wire schemas. "Not gatekeeping" is served by making endpoint promotion a ~30-line recipe, not by freezing the fast-moving app API into a public contract.

---

## 1. Current state (verified inventory)

Four URL planes on the regional backend (`apps/backend/src/routes.ts`):

| Plane              | Prefix                               | Auth                                        | Notes                                           |
| ------------------ | ------------------------------------ | ------------------------------------------- | ----------------------------------------------- |
| App API            | `/api/...`                           | session cookie                              | ~200 routes, changes with every frontend deploy |
| Public API         | `/api/v1/...`                        | `Bearer threa_uk_*` / `threa_bk_*` + scopes | ~50 routes, curated wire shapes                 |
| Service-to-service | `/internal/...`                      | shared secrets                              | control-plane → backend, enclave callbacks      |
| Ops                | `/readyz`, `/metrics`, `/debug/pool` | ops gate                                    |                                                 |

Load-bearing facts for this design:

- **Route registry is already the SSOT**: `apps/backend/src/features/public-api/routes.ts` (`PUBLIC_API_ROUTES`, line 592) declares method/path/operationId/scopes/request+response Zod schemas per endpoint; `apps/backend/scripts/generate-api-docs.ts` generates `docs/public-api/openapi.json` from it with a `--check` drift gate. The Express registrations in `src/routes.ts:911-1154` duplicate it by hand.
- **workspace-router** (`apps/workspace-router/src/index.ts`): `PUBLIC_API_ROUTE_RE = /^\/api\/v1\/workspaces\/([^/]+)/` (line 53) and `WORKSPACE_ROUTE_RE = /^\/api\/workspaces\/([^/]+)/` (line 51) both feed `routeWorkspaceRequest`, which parses the **workspace id from the path** to resolve the region. The staging hostname-pin guard terminates all `/api/*` paths (line 167). Consequences: the workspace id must stay positionally extractable, and paths must stay under `/api/` — so "bare" means `/api/workspaces/...`, not `/workspaces/...`.
- **External clients each build paths in one helper**: `extensions/bot-runtime-client/src/transport.ts:449` (`v1Path`), `extensions/remote-session/src/client.ts:147` (`buildPath`), `extensions/pi-remote/src/threa-remote.ts` (~25 literals joined at line 628). All store an origin `baseUrl` defaulting to `https://app.threa.io`.
- **Frontend** routes every call through one `apiFetch` wrapper (`apps/frontend/src/api/client.ts:57`), with `/api/workspaces/...` literals in ~56 files.
- **CORS is one global policy** (`app.ts:57`): allowlist + `credentials: true` for everything. No public/app split exists — but the developers playground on the public site does in-browser calls, so the public API needs cross-origin reachability the app API must never get with credentials.
- **Scope failures return 404** (existence-hiding) in `requireApiKeyScope` (`middleware/public-api-auth.ts:126`).
- **No versioning machinery exists** — `info.version: "1.0.0"` in the OpenAPI spec is decorative. Greenfield.
- Other consumers to update when paths move: `.github/workflows/{notify,staging}.yml` (curl `/api/v1`), `.agents/skills/threa-public-api/SKILL.md`, `update-pi-remote-plugin/SKILL.md`, `apps/public-site/src/pages/developers/*.astro` (hand-written prose hardcoding `/api/v1`), `apps/backend/tests/e2e/public-api-*.test.ts`, `apps/backend/tests/client.ts:907`.

---

## 2. Version scheme

### 2.1 The header

`Threa-Version: 2026-07-12` — date-based, like `Stripe-Version` / `Anthropic-Version`. No `X-` prefix (RFC 6648; the existing `X-Threa-*` headers are internal plumbing and stay as they are).

Resolution precedence, applied by middleware after key auth:

1. `Threa-Version` request header, if present. Must be an exact member of the known-versions list — **not** free-form dates. Unknown, malformed, or future value → `400 INVALID_API_VERSION` with the known versions in the error body (fail loudly, INV-11; silently clamping a typo'd date to "latest" is exactly the corruption-hiding fallback we ban).
2. The key's pinned `api_version` (always present after the backfill migration).

Every response echoes the resolved version: `Threa-Version: 2026-07-12`, and it's added to `Access-Control-Expose-Headers`.

### 2.2 Pinning at key mint

New `api_version TEXT` column on `user_api_keys` and `bot_api_keys` (append-only migration under `apps/backend/src/db/migrations/`):

```sql
ALTER TABLE user_api_keys ADD COLUMN api_version TEXT;
ALTER TABLE bot_api_keys ADD COLUMN api_version TEXT;
-- Existing keys speak today's shapes, which *are* the epoch version.
UPDATE user_api_keys SET api_version = '2026-07-12' WHERE api_version IS NULL;
UPDATE bot_api_keys SET api_version = '2026-07-12' WHERE api_version IS NULL;
```

(Epoch = ship date of Phase 1, fixed at `2026-07-12`.) New keys are minted at the then-current version. `TEXT`, validated in code against the version list (INV-3). No user-facing version picker for now — a key's pin is upgradeable later via the existing key-management PATCH if we ever want it; do not build UI speculatively (INV-36).

A key can also be **unpinned** (`api_version = NULL`, follow-up to Kris's 2026-07-12 request): the resolution chain then lands on `CURRENT_API_VERSION`, so the key always speaks the latest shapes, breaking changes included. Detach/re-pin is a management-plane operation — `PATCH` on the app API's key endpoints with `apiVersion: "<date>" | null` — and `GET /api/v1/.../me` reports `apiVersion: { pinned, resolved, current, supported }` so an agent can discover its pin. Changing the pin deliberately stays off the public API: an agent may discover it is behind, not silently rewrite its own wire contract.

An integrator's upgrade story: their key is pinned at 2026-07-12; when we ship the 2026-11-01 version, nothing changes for them; they test with `Threa-Version: 2026-11-01` on individual requests; when ready, they either send the header everywhere or mint a new key.

### 2.3 What counts as a breaking change (needs a new version) vs not

Additive = no new version: new endpoints, new optional request fields, new response fields, new enum values _in responses documented as open sets_. Breaking = new dated version + change module: removing/renaming a field, changing a type or semantics, tightening request validation, changing a default, changing an error code/status. Same taxonomy Stripe uses; goes verbatim into the developer docs.

---

## 3. Version-change machinery

Handlers and serializers always produce/consume the **latest** shape. Each dated version is defined by a module describing how to translate between it and the version after it. At request time:

- **Request upgrade**: apply changes _newer than the client's version_, oldest→newest, to `req.body`/`req.query` before the handler's Zod validation runs.
- **Response downgrade**: apply the same changes newest→oldest to the outgoing payload, via a `res.json` wrap installed by the version middleware.

Changes are scoped by `operationId` (the registry already names every endpoint). A change touching a shared wire resource (e.g. the message object appears in `listMessages`, `sendMessage`, `searchMessages`, `findMessagesByMetadata`) declares one transform function and lists the operations it applies to — explicit and compile-checked rather than a magic deep-walker.

```text
apps/backend/src/features/public-api/versions/
  index.ts                        # ordered registry + resolution helpers
  types.ts                        # ApiVersion, VersionChange
  2026-11-01-stream-name.ts       # one module per dated version (example, §8)
  2026-11-01-stream-name.test.ts  # golden request/response pairs per version
```

### 3.1 Registry-driven route mounting (prerequisite refactor)

Today `src/routes.ts:911-1154` hand-duplicates the registry. Phase 1 replaces those ~250 lines with a mount loop, which is also the only sane place to attach the version gate:

- `PUBLIC_API_ROUTES` stays the SSOT; Express paths derived from the OpenAPI-style ones (`{workspaceId}` → `:workspaceId`).
- A handler map `Record<OperationId, RequestHandler | RequestHandler[]>` (array for the multipart upload route that needs `rateLimits.upload` + `upload` in the chain), checked for exhaustiveness at startup — a registry entry without a handler or vice versa throws at boot, killing the drift-check class entirely.
- Scopes come from the registry, so `requireApiKeyScope` can't disagree with the docs.

This refactor is behavior-neutral and independently shippable as PR 1 of the phase.

---

## 4. URL schema (Phase 2, severable)

### 4.1 Recommended endgame: one `/api` namespace, credential-dispatched

- **Public API**: `/api/workspaces/:workspaceId/...` (bare — the `v1` segment dies).
- **App API**: unchanged, `/api/workspaces/:workspaceId/...`. No frontend migration at all.
- **Dispatch**: a guard at the top of the public router: if `Authorization` doesn't start with `Bearer threa_`, `next("router")` — the request falls through to the app routes. Bearer-`threa_*` requests that match no public route also fall through (so e.g. bot-runtime-client's existing call to the app-plane `GET /api/workspaces/:id/config` keeps working). Explicit Bearer always wins over an also-present cookie.
- **`/internal`** stays exactly what it is (service-to-service). The instinct to move the app API under `/internal` would conflict with that established meaning; the credential dispatch makes moving the app API unnecessary anyway.
- **`/api/v1` alias**: a rewrite middleware (`req.url = req.url.replace(/^\/api\/v1\//, "/api/")`) mounted before the public router, adding `Deprecation: true` and a `Sunset` header once a removal date is picked. Kept ≥6 months, removed when telemetry says it's quiet.
- **workspace-router**: `WORKSPACE_ROUTE_RE` already matches the bare form; keep `PUBLIC_API_ROUTE_RE` until the alias dies, then delete it. Staging guard unaffected (still `/api/`).

Trade-off to accept with open eyes: during overlap, the _same URL_ (`GET /api/workspaces/:id/streams`) returns the curated public wire shape to a key and the rich app shape to a cookie. That's unusual as API design goes, but it's coherent here: the public shape is the versioned contract, the app shape is a private implementation detail that happens to share a path. The `Threa-Version` echo header makes it unambiguous which plane answered. If this smells too strong, the fallback is simply keeping `/api/v1` forever, Stripe-style — everything else in this document works identically.

Why not fully bare (`/workspaces/...`)? The router's staging pin terminates on `/api/` (index.ts:167) and would route bare paths to the frontend Pages proxy; and every consumer already carries `/api`. Cost with no benefit.

### 4.2 CORS split

Preflights carry no `Authorization`, so OPTIONS can't credential-dispatch. Policy that works for both planes on shared paths:

- Origin on the app allowlist → current behavior (reflect origin, `credentials: true`).
- Any other origin → reflect origin, `credentials: false`, allow `Authorization, Content-Type, Threa-Version, Idempotency-Key`-style headers.

Cookies never flow cross-origin (browser enforces via the no-credentials grant), keys are never _ambient_ (an attacker page can't use a victim's key without possessing it), so opening origins for the keyed plane is safe and is what the developers-playground "Run" button needs anyway.

---

## 5. Public/app unification: plumbing yes, surface no

**Recommended: do not unify the handler surface.** Reasons:

- The app API co-evolves with the frontend weekly (same deploy, same repo — it's not a contract, it's a function call across HTTP). Making it public freezes it under the compatibility guarantee and every product iteration starts paying the version-module tax. That's the "mess up when moving fast" risk you named, made structural.
- The public wire is deliberately narrower: `sanitize.ts`, curated serializers, scope gating, existence-hiding 404s. Dual-auth'ing the app handlers would leak app-shape internals to keys by default — the unsafe direction.

**What to unify instead** (this is where footprint/deviation actually shrinks):

- **Namespace** (§4): one `/api`, credential-dispatched.
- **Principal model**: fold `req.userApiKey` / `req.botApiKey` / session into one `req.principal = { kind: "session" | "user_key" | "bot_key", userId?, botId?, scopes }`. App routes can then adopt scope checks incrementally; services stay principal-agnostic (they already are).
- **Services** — already shared; public handlers delegate to the same `EventService`/`StreamService`/etc. Deviation risk lives in serializers, which is exactly where the versioned contract needs it to live.
- **Promotion recipe** — "not gatekeeping" operationalized. Making an app capability public = one registry entry (path/scopes/schemas), one serializer (or reuse), one handler delegating to the existing service, tests. ~30 lines + docs regen. Document this recipe in `docs/public-api/` and treat "should this be public?" as a per-endpoint product decision with a cheap yes.

Endgame option (later, not now): individual routes whose public and app shapes genuinely converge can collapse into a single registration served to both principals. The architecture above permits it per-route; nothing forces it.

---

## 6. Grace & deprecation policy

- **API versions**: supported ≥12 months after being succeeded. With the current integrator count this costs near-nothing; revisit the window when the version-module count grows.
- **`/api/v1` path alias**: ≥6 months, `Deprecation`/`Sunset` headers from day one, removal gated on telemetry.
- **Telemetry**: log `{ apiVersion, versionSource: "header"|"key", keyId, operationId }` per public request (extend the existing request logging), so "who still sends v1 paths / old versions" is a log query, not a guess.
- **Changelog**: `docs/public-api/CHANGELOG.md` generated from the version modules' `description`/`changelog` fields by `generate-api-docs.ts`, rendered on the developers site next to the reference.

---

## 7. Example implementation A — the versioning substrate

Everything below is written to drop into the existing idioms (factories, `HttpError`, Zod, INV-51 colocation).

### 7.1 `features/public-api/versions/types.ts`

```ts
import type { OperationId } from "../routes"

/** Dated public API versions, ascending. The first entry is the epoch. */
export const API_VERSIONS = ["2026-07-12"] as const
export type ApiVersion = (typeof API_VERSIONS)[number]
export const CURRENT_API_VERSION: ApiVersion = API_VERSIONS[API_VERSIONS.length - 1]

export interface VersionChangeContext {
  operationId: OperationId
}

/**
 * One dated, breaking change. `version` is the date the NEW behavior became
 * default; callers pinned BEFORE it get the transforms applied.
 * Transforms translate between this version's shape and the previous one:
 * upgradeRequest lifts an old-shape request to the new shape, downgradeResponse
 * lowers a new-shape payload to the old shape. Both must be pure.
 */
export interface VersionChange {
  version: ApiVersion
  /** One-line summary for the generated CHANGELOG. */
  description: string
  /** Operations whose requests/responses this change touches. */
  operations: ReadonlySet<OperationId>
  upgradeRequest?: (body: unknown, ctx: VersionChangeContext) => unknown
  downgradeResponse?: (payload: unknown, ctx: VersionChangeContext) => unknown
}
```

(`OperationId` = a union derived from the registry: `export type OperationId = (typeof PUBLIC_API_ROUTES)[number]["operationId"]` once the registry is `as const`-friendly, or a string union maintained beside it.)

### 7.2 `features/public-api/versions/index.ts`

```ts
import { HttpError } from "@threa/backend-common"
import { API_VERSIONS, CURRENT_API_VERSION, type ApiVersion, type VersionChange } from "./types"

/** Ascending by version. Startup assertion enforces ordering + known dates. */
export const VERSION_CHANGES: VersionChange[] = [
  // e.g. streamNameChange (§8) once the first real change ships
]

for (let i = 1; i < VERSION_CHANGES.length; i++) {
  if (VERSION_CHANGES[i - 1].version >= VERSION_CHANGES[i].version) {
    throw new Error("VERSION_CHANGES must be strictly ascending by version")
  }
}

const KNOWN = new Set<string>(API_VERSIONS)

export function parseApiVersion(raw: string): ApiVersion {
  if (!KNOWN.has(raw)) {
    throw new HttpError(`Unknown API version "${raw}". Known versions: ${API_VERSIONS.join(", ")}`, {
      status: 400,
      code: "INVALID_API_VERSION",
    })
  }
  return raw as ApiVersion
}

/** Changes the caller is behind on, i.e. with version strictly newer than theirs. */
export function changesAfter(clientVersion: ApiVersion): VersionChange[] {
  // ISO dates compare lexicographically — no Date parsing.
  return VERSION_CHANGES.filter((c) => c.version > clientVersion)
}

export { API_VERSIONS, CURRENT_API_VERSION }
export type { ApiVersion }
```

### 7.3 Version gate middleware — `middleware/api-version.ts`

Mounted per-route by the registry loop, _after_ `publicApiAuth` (needs the validated key for the pin) and _before_ the handler.

```ts
import type { NextFunction, Request, Response } from "express"
import type { OperationId } from "../features/public-api/routes"
import { changesAfter, parseApiVersion, CURRENT_API_VERSION, type ApiVersion } from "../features/public-api/versions"

declare global {
  namespace Express {
    interface Request {
      apiVersion?: ApiVersion
    }
  }
}

export function createApiVersionGate(operationId: OperationId) {
  return function apiVersionGate(req: Request, res: Response, next: NextFunction): void {
    const header = req.header("Threa-Version")
    const pinned = req.userApiKey?.apiVersion ?? req.botApiKey?.apiVersion ?? CURRENT_API_VERSION
    const version = header ? parseApiVersion(header) : pinned

    req.apiVersion = version
    res.setHeader("Threa-Version", version)

    const pending = changesAfter(version).filter((c) => c.operations.has(operationId))
    if (pending.length === 0) return next()

    // Upgrade the request oldest→newest so the handler's Zod validation sees
    // the current shape.
    for (const change of pending) {
      if (change.upgradeRequest) req.body = change.upgradeRequest(req.body, { operationId })
    }

    // Downgrade the response newest→oldest on the way out.
    const json = res.json.bind(res)
    res.json = (payload: unknown) => {
      let out = payload
      for (let i = pending.length - 1; i >= 0; i--) {
        const change = pending[i]
        if (change.downgradeResponse) out = change.downgradeResponse(out, { operationId })
      }
      return json(out)
    }
    next()
  }
}
```

`ValidatedUserApiKey` / `ValidatedBotApiKey` gain `apiVersion: ApiVersion` (read in the same `SELECT` the services already do), and the create paths write `CURRENT_API_VERSION`.

### 7.4 Registry-driven mounting — replaces `src/routes.ts:911-1154`

```ts
import { PUBLIC_API_ROUTES, type OperationId } from "./features/public-api/routes"
import { createApiVersionGate } from "./middleware/api-version"

function toExpressPath(openApiPath: string): string {
  return openApiPath.replace(/\{(\w+)\}/g, ":$1")
}

const publicHandlers: Record<OperationId, RequestHandler | RequestHandler[]> = {
  searchMessages: publicApi.searchMessages,
  sendMessage: publicApi.sendMessage,
  uploadAttachment: [rateLimits.upload, upload, publicApi.uploadAttachment],
  // ... every operationId; exhaustiveness enforced by the Record type
}

for (const route of PUBLIC_API_ROUTES) {
  const handler = publicHandlers[route.operationId]
  if (!handler) throw new Error(`No handler for public API operation ${route.operationId}`)
  app[route.method](
    toExpressPath(route.path),
    ...publicMiddleware,
    createApiVersionGate(route.operationId),
    requireApiKeyScope(...route.scopes),
    ...(Array.isArray(handler) ? handler : [handler])
  )
}
```

The `Record<OperationId, ...>` type makes a missing handler a compile error and the boot-time throw catches a registry/handler mismatch in dev before any request. The pre-commit OpenAPI drift check stays; the _route_ drift check becomes structural.

### 7.5 OpenAPI generator changes

- `info.version` = `CURRENT_API_VERSION`.
- A global `Threa-Version` header parameter (optional, enum of `API_VERSIONS`) added to every operation via `components.parameters`.
- Emit `docs/public-api/CHANGELOG.md` from `VERSION_CHANGES` (version, description, affected operations).
- Spec documents only the current version (Stripe does the same); older shapes live in the changelog + version modules. Per-version spec generation is possible later (changes could carry schema patches) — deferred, YAGNI until an integrator asks.

---

## 8. Example implementation B — a worked version change

Scenario: we rename `displayName` → `name` on the stream wire object (it's the only public resource using `displayName`; every other resource says `name`). Touches every operation that returns a stream and the `updateStream` request body.

`features/public-api/versions/2026-11-01-stream-name.ts`:

```ts
import type { VersionChange } from "./types"

const OPERATIONS = new Set(["listStreams", "getStream", "updateStream"] as const)

function renameInStream(stream: Record<string, unknown>): Record<string, unknown> {
  const { name, ...rest } = stream
  return { ...rest, displayName: name }
}

export const streamNameChange: VersionChange = {
  version: "2026-11-01",
  description: "Stream objects: `displayName` renamed to `name`; `PATCH streams/:id` accepts `name`.",
  operations: OPERATIONS,

  // Old callers PATCH { displayName } — lift it to the current { name } shape
  // before the handler's Zod schema (which only knows `name`) validates it.
  upgradeRequest(body, { operationId }) {
    if (operationId !== "updateStream" || typeof body !== "object" || body === null) return body
    const { displayName, ...rest } = body as Record<string, unknown>
    return displayName === undefined ? body : { ...rest, name: displayName }
  },

  // Handlers emit { name }; old callers see { displayName }.
  downgradeResponse(payload, { operationId }) {
    const envelope = payload as { data: unknown }
    if (operationId === "listStreams") {
      return { ...envelope, data: (envelope.data as Record<string, unknown>[]).map(renameInStream) }
    }
    return { ...envelope, data: renameInStream(envelope.data as Record<string, unknown>) }
  },
}
```

Shipping it:

1. Append `"2026-11-01"` to `API_VERSIONS`; register `streamNameChange` in `VERSION_CHANGES`.
2. Rename the field in `streamSchema` + `serializeStream` (registry + serializer only — handlers untouched).
3. Regenerate the spec; the changelog entry falls out of `description`.
4. Golden tests (`2026-11-01-stream-name.test.ts`): one e2e-ish pair per direction — `GET streams` with `Threa-Version: 2026-07-12` asserts `displayName` and no `name`; with `2026-11-01` asserts the inverse; `PATCH` with old header + `{ displayName }` succeeds and renames. Assert the echo header both ways.

That module is the template for every future breaking change: ~40 lines, no handler edits, no route edits.

One constraint every `downgradeResponse` must respect: the `res.json` wrap sees **every** payload the route emits for a behind-version caller, including the error envelope (`{ error, code }`) produced by `errorHandler` after the wrap is installed. Transforms must pass through payloads that don't match the success shape untouched (the example above does this implicitly — it only rewrites the `data` field it finds). Add a golden test for the error path when the transform destructures the envelope.

## 9. Example implementation C — the path move (Phase 2)

Backend, in `src/routes.ts` before the public mount loop:

```ts
// Legacy /api/v1 alias — public API paths went bare (see
// docs/plans/public-api-header-versioning.md). Remove after sunset.
app.use((req, res, next) => {
  if (req.url.startsWith("/api/v1/")) {
    req.url = "/api" + req.url.slice("/api/v1".length)
    res.setHeader("Deprecation", "true")
    // res.setHeader("Sunset", "<HTTP-date once picked>")
  }
  next()
})
```

Registry paths change `"/api/v1/workspaces/{workspaceId}/..."` → `"/api/workspaces/{workspaceId}/..."`; spec regen picks it up. The credential guard heads the public mount loop:

```ts
const publicRouter = express.Router()
publicRouter.use((req, _res, next) => {
  const auth = req.headers.authorization
  if (!auth?.startsWith("Bearer threa_")) return next("router") // fall through to app routes
  next()
})
// ...mount loop from §7.4 targets publicRouter; app.use(publicRouter) before app routes
```

Client side, one helper each — e.g. `extensions/bot-runtime-client/src/transport.ts`:

```ts
private v1Path(suffix: string): string {
  return `/api/workspaces/${this.workspaceId}${suffix}`   // was /api/v1/workspaces
}
// and in the fetch wrapper:
headers: { ...headers, "Threa-Version": THREA_API_VERSION }
```

Same one-line change in `remote-session/src/client.ts:147` and `pi-remote/src/threa-remote.ts` (its ~25 literals share the `config.baseUrl` join at line 628 — a `wsPath()` helper extraction is the tidy version). Then the docs/CI sweep: `public-site/src/pages/developers/*.astro`, `threa-public-api` + `update-pi-remote-plugin` skills, `.github/workflows/{notify,staging}.yml`, backend e2e tests + `tests/client.ts`.

---

## 10. Rollout

**Phase 1 — versioning substrate (no wire change, no URL change):**

1. PR: registry-driven mounting (§7.4), behavior-neutral.
2. PR: `api_version` columns + pin-at-mint + `Threa-Version` resolution/echo + version-gate middleware + telemetry fields. `API_VERSIONS = [epoch]`, `VERSION_CHANGES = []` — the machinery runs but transforms nothing.
3. PR: OpenAPI/docs — header documented, changelog scaffold, deprecation-policy page on the developers site.

**Phase 2 — bare paths (optional, decide separately):** alias middleware + credential guard + registry path change + client/docs/CI sweep + CORS split (§4.2). Router: keep both regexes until sunset.

**Phase 3 — first real version change:** use §8 as the template. Nothing needs to exist before a real need arrives.

**Testing:** golden per-change tests (§8.4); an invariant test over `API_VERSIONS`/`VERSION_CHANGES` ordering; e2e: unknown version → 400, header override beats pin, echo header, `/api/v1` alias equivalence during Phase 2 (`public-api-openapi.test.ts` runs against both prefixes until sunset).

## 11. Decisions (Kris, 2026-07-11)

1. **Phase 2: skipped for now.** `/api/v1` stays as a frozen path prefix, Stripe's own choice. Header versioning (Phase 1) proceeds on the existing paths. §4 and §9 are kept as the reference design should this be revisited; nothing in Phase 1 forecloses it.
2. **Dual-shape same-URL: dissolved by (1).** Kris's concern — same URL serving different shapes is confusing for agents and developers deciding what should be served — is a real argument and reinforces the skip. One URL = one shape stands.
3. **Version support window: ≥12 months** after a version is succeeded.
4. **Key-pin UI: deferred** (INV-36). Pinning itself still ships in Phase 1 (`api_version` column, pin-at-mint, header override); only the settings-UI surfacing waits until a second version exists.
