#!/usr/bin/env bun
/**
 * Seeds the reproduction fixtures behind `docs/perf/reproduction-matrix.md`.
 *
 * Thin driver: the profile → work mapping lives in `lib/perf-seed-plan.ts` and
 * is unit-tested without a network. This file only resolves the plan's keys to
 * real ids and pushes the operations over the REST API.
 *
 * Every profile but `missed-entries` is idempotent — it counts what its own
 * marker prefix already put in the workspace and tops up. Re-running is safe;
 * it is the intended way to grow a fixture. `missed-entries` instead marks each
 * run separately and drives the workspace sync head forward by the requested
 * delta, so every invocation opens a fresh gap.
 */

import {
  PERF_SEED_FIXED_PROFILES,
  PERF_SEED_PARAMETERISED_PROFILE,
  messageContent,
  messagesForMissedEntries,
  parseProfile,
  planSeed,
  seedSpec,
  type ExistingState,
  type ParsedProfile,
  type PlannedStreamSlot,
} from "./lib/perf-seed-plan"

const BATCH_SIZE = 5
const EVENT_PAGE_SIZE = 200
/** `stream_events.event_type` for a posted message — not the socket/outbox `message:created` name. */
const MESSAGE_EVENT_TYPE = "message_created"
const DEFAULT_EMAIL = "perf-seed@example.com"
/**
 * Message creation is rate-limited per user (120/min, `middleware/rate-limit.ts`),
 * which alone would put `large-stream` at ~42 minutes. Seeding round-robins over
 * this many stub authors instead — a busy channel has many authors anyway.
 */
const DEFAULT_AUTHORS = 6
const RATE_LIMIT_RETRIES = 6
/** Past any real sync id, so the head probe returns the head and no entries. */
const HEAD_PROBE_CURSOR = "9223372036854775807"

function authorCount(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_AUTHORS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 24) {
    throw new Error(`--authors must be an integer between 1 and 24, got "${raw}".`)
  }
  return parsed
}

/** `perf-seed@example.com` + index 2 → `perf-seed+2@example.com`. */
function authorEmail(base: string, index: number): string {
  if (index === 0) return base
  const [local, domain] = base.split("@")
  if (!domain) throw new Error(`--email must be an address, got "${base}".`)
  return `${local}+${index}@${domain}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const USAGE = `
perf-seed — seed performance reproduction fixtures into a running stack.

Usage:
  bun scripts/perf-seed.ts --workspace <workspaceId> --profile <name> [options]

Profiles:
  ${PERF_SEED_FIXED_PROFILES.join("\n  ")}
  ${PERF_SEED_PARAMETERISED_PROFILE}=<N>   advance the sync log by N entries

Options:
  --workspace <id>    Target workspace (required).
  --profile <name>    Profile to seed (required).
  --base-url <url>    Backend base URL. Default: http://localhost:$DEV_TEST_BACKEND_PORT
  --email <address>   Base stub-auth identity. Default: perf-seed@example.com
  --authors <n>       Stub authors to spread posting over. Default: 6
  --dry-run           Log in once (read-only) and print the plan without writing.
                      A workspace the seed user is not a member of is not joined
                      on a dry run, so existing counts print as unknown and the
                      plan is the one for an empty workspace.
  --help

Auth: the dev:test stack's stub auth (POST /api/dev/login), the same path the
browser suite uses. This script targets a local stack only — it has no API-key
path and must never be pointed at staging or production.

Rate limits: message creation is capped per user, so seeding posts as N stub
authors (--authors, default 6) derived from --email as base+1@, base+2@, and so on.
The binding limit on a dev stack is the GLOBAL per-IP cap (300/min), which no
number of authors escapes — start the stack with GLOBAL_RATE_LIMIT_MAX=10000
(the same value playwright.config.ts uses). A 429 is retried with backoff first.

Missed entries: \`missed-entries=<N>\` reads the workspace sync head, posts
batches carrying a per-run marker, and stops once the head has advanced by at
least N. A message writes three or more entries and the exact number is
workload-dependent, so the achieved delta is measured and printed — read it,
do not compute it. Each run opens a fresh gap.

Start the stack first:
  GLOBAL_RATE_LIMIT_MAX=10000 DEV_TEST_BACKEND_PORT=4001 bun run dev:test
`

interface Args {
  workspaceId: string
  profile: ParsedProfile
  baseUrl: string
  email: string
  authors: number
  dryRun: boolean
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>()
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE)
      process.exit(0)
    }
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}". See --help.`)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith("--")) throw new Error(`Flag ${arg} needs a value. See --help.`)
    flags.set(arg.slice(2), value)
    i++
  }

  const workspaceId = flags.get("workspace")
  if (!workspaceId) throw new Error("--workspace is required. See --help.")
  const profileRaw = flags.get("profile")
  if (!profileRaw) throw new Error("--profile is required. See --help.")

  const backendPort = process.env.DEV_TEST_BACKEND_PORT
  const baseUrl = flags.get("base-url") ?? (backendPort ? `http://localhost:${backendPort}` : undefined)
  if (!baseUrl) {
    throw new Error("No --base-url and no DEV_TEST_BACKEND_PORT in the environment. See --help.")
  }
  // Local-only tool. Any non-loopback deployment running stub auth (a preview
  // env, a misconfigured staging) would happily accept the whole fixture.
  const host = new URL(baseUrl).hostname
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`perf-seed only targets a local stack; refusing host "${host}".`)
  }

  return {
    workspaceId,
    profile: parseProfile(profileRaw),
    baseUrl: baseUrl.replace(/\/$/, ""),
    email: flags.get("email") ?? DEFAULT_EMAIL,
    authors: authorCount(flags.get("authors")),
    dryRun,
  }
}

/**
 * Minimal cookie-carrying client. Bun's fetch does not keep a jar, and the stub
 * session rides a cookie, so every later request has to replay it.
 */
class SeedClient {
  private cookie = ""

  constructor(private readonly baseUrl: string) {}

  /**
   * True when the caller can already read the workspace, i.e. is a member.
   * Only auth-shaped statuses mean "not a member" — a 429/5xx must not be
   * mistaken for one and trigger a join.
   */
  async canReach(path: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { ...(this.cookie ? { cookie: this.cookie } : {}) },
    })
    if (response.ok) return true
    if ([401, 403, 404].includes(response.status)) return false
    const text = await response.text().catch(() => "<unreadable body>")
    throw new Error(`GET ${path} failed: ${response.status} ${response.statusText} — ${text}`)
  }

  async request(method: string, path: string, body?: unknown, attempt = 0): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const setCookie = response.headers.getSetCookie?.() ?? []
    if (setCookie.length > 0) {
      this.cookie = setCookie.map((c) => c.split(";")[0]).join("; ")
    }

    // A 429 is expected under sustained seeding and is retryable; everything
    // else is not.
    if (response.status === 429) {
      if (attempt < RATE_LIMIT_RETRIES) {
        await response.text().catch(() => "")
        await sleep(2_000 * 2 ** attempt)
        return this.request(method, path, body, attempt + 1)
      }
      throw new Error(
        `${method} ${path} still 429 after ${RATE_LIMIT_RETRIES} retries. The per-IP global limiter is the usual cause — restart the stack with GLOBAL_RATE_LIMIT_MAX=10000.`
      )
    }

    // Fail loudly (INV-11): a half-seeded fixture that reported success is
    // worse than no fixture, because every later measurement is against a
    // silently wrong shape.
    if (!response.ok) {
      const text = await response.text().catch(() => "<unreadable body>")
      throw new Error(`${method} ${path} failed: ${response.status} ${response.statusText} — ${text}`)
    }

    const text = await response.text()
    return text.length === 0 ? undefined : JSON.parse(text)
  }
}

interface StreamRow {
  id: string
  slug?: string | null
  displayName?: string | null
  type: string
}

async function loginOnly(client: SeedClient, email: string): Promise<void> {
  await client.request("POST", "/api/dev/login", { email, name: "perf-seed" })
}

async function login(client: SeedClient, workspaceId: string, email: string): Promise<void> {
  await loginOnly(client, email)
  // The stub join is an add, not an upsert: it errors for a user who is already
  // a member (the common case — the workspace's creator). Only join when the
  // workspace is out of reach.
  if (!(await client.canReach(`/api/workspaces/${workspaceId}`))) {
    await client.request("POST", `/api/dev/workspaces/${workspaceId}/join`, {})
  }
}

async function listStreams(client: SeedClient, workspaceId: string): Promise<StreamRow[]> {
  const channels = (await client.request("GET", `/api/workspaces/${workspaceId}/streams`)) as {
    streams: StreamRow[]
  }
  const threads = (await client.request("GET", `/api/workspaces/${workspaceId}/streams?stream_type=thread`)) as {
    streams: StreamRow[]
  }
  return [...channels.streams, ...threads.streams]
}

/** A slot's stream is identified by slug for channels and by display name for threads (threads have no slug). */
function findSlotStream(streams: StreamRow[], slot: PlannedStreamSlot): StreamRow | undefined {
  return slot.kind === "channel"
    ? streams.find((s) => s.slug === slot.key)
    : streams.find((s) => s.type === "thread" && s.displayName === slot.key)
}

/** Marker-bearing messages already in a stream. Pages backwards through the event log. */
async function countMarkedMessages(
  client: SeedClient,
  workspaceId: string,
  streamId: string,
  marker: string
): Promise<number> {
  let before: string | undefined
  let count = 0
  for (;;) {
    const query = new URLSearchParams({ type: MESSAGE_EVENT_TYPE, limit: String(EVENT_PAGE_SIZE) })
    if (before) query.set("before", before)
    const page = (await client.request(
      "GET",
      `/api/workspaces/${workspaceId}/streams/${streamId}/events?${query}`
    )) as { events: { sequence: string; payload?: { contentMarkdown?: string | null } }[] }

    if (page.events.length === 0) return count
    for (const event of page.events) {
      if (event.payload?.contentMarkdown?.startsWith(marker)) count++
    }
    if (page.events.length < EVENT_PAGE_SIZE) return count
    before = page.events[0]!.sequence
  }
}

async function readExistingState(
  client: SeedClient,
  workspaceId: string,
  profile: ParsedProfile
): Promise<{ existing: ExistingState; streamIds: Map<string, string> }> {
  const spec = seedSpec(profile)
  const streams = await listStreams(client, workspaceId)
  const messageCounts: Record<string, number | undefined> = {}
  const streamIds = new Map<string, string>()

  for (const slot of spec.slots) {
    const found = findSlotStream(streams, slot)
    if (!found) continue
    streamIds.set(slot.key, found.id)
    // A slot with no message target has nothing to top up, and paging its whole
    // event log to learn that costs more the longer the fixture lives.
    messageCounts[slot.key] =
      slot.messageTarget === 0 ? 0 : await countMarkedMessages(client, workspaceId, found.id, slot.key)
  }

  const draftKeys: string[] = []
  if (spec.drafts.length > 0) {
    const { drafts } = (await client.request("GET", `/api/workspaces/${workspaceId}/drafts`)) as {
      drafts: { scope: string }[]
    }
    const scopedStreamIds = new Set(drafts.map((d) => d.scope.replace(/^stream:/, "")))
    for (const draft of spec.drafts) {
      const streamId = streamIds.get(draft.key)
      if (streamId && scopedStreamIds.has(streamId)) draftKeys.push(draft.key)
    }
  }

  return { existing: { messageCounts, draftKeys }, streamIds }
}

/** Give every author a membership so it can post into `streamId`. Idempotent server-side. */
async function joinStream(authors: SeedClient[], workspaceId: string, streamId: string): Promise<void> {
  for (const author of authors) {
    await author.request("POST", `/api/dev/workspaces/${workspaceId}/streams/${streamId}/join`, {})
  }
}

/**
 * Post messages in bounded parallel batches — the `infinite-scroll.spec.ts`
 * shape — round-robining authors so the per-user create limit is not the
 * bottleneck.
 */
const joinedStreams = new Set<string>()

async function postMessages(
  authors: SeedClient[],
  workspaceId: string,
  streamId: string,
  key: string,
  from: number,
  count: number
): Promise<void> {
  if (!joinedStreams.has(streamId)) {
    await joinStream(authors, workspaceId, streamId)
    joinedStreams.add(streamId)
  }
  const last = from + count - 1
  for (let start = from; start <= last; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE - 1, last)
    const batch: Promise<unknown>[] = []
    for (let ordinal = start; ordinal <= end; ordinal++) {
      batch.push(
        authors[ordinal % authors.length]!.request("POST", `/api/workspaces/${workspaceId}/messages`, {
          streamId,
          content: messageContent(key, ordinal),
        })
      )
    }
    await Promise.all(batch)
    if ((end - from + 1) % 500 === 0 || end === last) {
      console.log(`  ${key}: ${end - from + 1}/${count} messages`)
    }
  }
}

/**
 * The workspace sync head. Catch-up returns it regardless of the cursor, so a
 * cursor far past the end is the cheapest probe: no entries come back.
 */
async function readSyncHead(client: SeedClient, workspaceId: string): Promise<bigint> {
  const response = (await client.request(
    "GET",
    `/api/workspaces/${workspaceId}/sync?after=${HEAD_PROBE_CURSOR}&limit=1`
  )) as { head: string }
  return BigInt(response.head)
}

/**
 * Post batches until the sync head has advanced by `entries`, re-reading the
 * head between batches. Entries per message are workload-dependent, so the only
 * honest stopping condition is the measured delta. Returns what was achieved.
 */
async function advanceSyncLog(
  authors: SeedClient[],
  workspaceId: string,
  streamId: string,
  runMarker: string,
  entries: number
): Promise<{ delta: bigint; messages: number }> {
  const startHead = await readSyncHead(authors[0]!, workspaceId)
  let head = startHead
  let posted = 0
  while (head - startHead < BigInt(entries)) {
    const remaining = entries - Number(head - startHead)
    // Bounded rounds: the head is re-read between them, so a huge target can
    // never turn into one unbounded posting loop.
    const batch = Math.min(messagesForMissedEntries(remaining), 100)
    await postMessages(authors, workspaceId, streamId, runMarker, posted + 1, batch)
    posted += batch
    const next = await readSyncHead(authors[0]!, workspaceId)
    if (next === head) {
      throw new Error(`Sync head did not move after posting ${batch} message(s) to ${streamId}.`)
    }
    head = next
  }
  return { delta: head - startHead, messages: posted }
}

async function latestMessageId(client: SeedClient, workspaceId: string, streamId: string): Promise<string> {
  const page = (await client.request(
    "GET",
    `/api/workspaces/${workspaceId}/streams/${streamId}/events?type=${MESSAGE_EVENT_TYPE}&limit=1`
  )) as { events: { payload?: { messageId?: string } }[] }
  const id = page.events[0]?.payload?.messageId
  if (!id) throw new Error(`Stream ${streamId} has no message to anchor a thread on`)
  return id
}

function draftBody(chars: number): { type: "doc"; content: unknown[] } {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(chars) }] }] }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const spec = seedSpec(args.profile)
  const runMarker = `perf-missed-entries-run-${Date.now().toString(36)}`

  if (args.dryRun) {
    const reader = new SeedClient(args.baseUrl)
    await loginOnly(reader, authorEmail(args.email, 0))
    let existing: ExistingState = { messageCounts: {} }
    if (await reader.canReach(`/api/workspaces/${args.workspaceId}`)) {
      ;({ existing } = await readExistingState(reader, args.workspaceId, args.profile))
    } else {
      console.log(`(dry run: ${authorEmail(args.email, 0)} is not in ${args.workspaceId} — existing counts unknown)`)
    }
    const operations = planSeed(args.profile, existing, runMarker)
    console.log(`profile ${spec.profile} → ${operations.length} operation(s) outstanding`)
    for (const op of operations) console.log(`  ${JSON.stringify(op)}`)
    return
  }

  const authors: SeedClient[] = []
  for (let i = 0; i < args.authors; i++) {
    const author = new SeedClient(args.baseUrl)
    await login(author, args.workspaceId, authorEmail(args.email, i))
    authors.push(author)
  }
  // Reads, stream creation and drafts all run as the first author, so the
  // fixture has one owner and one draft scope regardless of --authors.
  const client = authors[0]!

  const { existing, streamIds } = await readExistingState(client, args.workspaceId, args.profile)
  const operations = planSeed(args.profile, existing, runMarker)

  console.log(`profile ${spec.profile} → ${operations.length} operation(s) outstanding`)
  if (operations.length === 0) {
    console.log("Already seeded — nothing to do.")
    return
  }

  const slotsByKey = new Map(spec.slots.map((slot) => [slot.key, slot]))

  for (const op of operations) {
    if (op.kind === "createStream") {
      const slot = slotsByKey.get(op.key)!
      const body =
        slot.kind === "channel"
          ? { type: "channel", slug: op.key, displayName: op.key }
          : {
              type: "thread",
              displayName: op.key,
              parentStreamId: streamIds.get(slot.parentKey!),
              parentAnchorId: await latestMessageId(client, args.workspaceId, streamIds.get(slot.parentKey!)!),
            }
      const { stream } = (await client.request("POST", `/api/workspaces/${args.workspaceId}/streams`, body)) as {
        stream: StreamRow
      }
      streamIds.set(op.key, stream.id)
      console.log(`  created ${slot.kind} ${op.key} → ${stream.id}`)
      continue
    }

    const streamId = streamIds.get(op.key)
    if (!streamId) throw new Error(`No stream resolved for slot "${op.key}"`)

    if (op.kind === "postMessages") {
      await postMessages(authors, args.workspaceId, streamId, op.key, op.from, op.count)
      continue
    }

    if (op.kind === "advanceSyncLog") {
      const { delta, messages } = await advanceSyncLog(authors, args.workspaceId, streamId, op.runMarker, op.entries)
      console.log(`  ${op.runMarker}: ${messages} message(s) → sync head advanced by ${delta} (asked ${op.entries})`)
      continue
    }

    await client.request("PUT", `/api/workspaces/${args.workspaceId}/drafts/${op.key}`, {
      scope: `stream:${streamId}`,
      expectedVersion: 0,
      writeId: `write_perfseed_${op.key}`,
      clientUpdatedAt: new Date().toISOString(),
      contentJson: draftBody(op.chars),
    })
    console.log(`  staged draft ${op.key} (${op.chars} chars)`)
  }

  console.log(`Done. profile ${spec.profile} is seeded.`)
}

await main()
