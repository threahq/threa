/**
 * Pure planning logic for `scripts/perf-seed.ts`, extracted so profile → work
 * mapping is unit-testable without a network. Keep this module side-effect free.
 *
 * A plan is derived twice: once to learn what a profile wants (`seedSpec`) and
 * once against what the workspace already holds (`planSeed`). Topping up rather
 * than re-seeding is what makes re-running a profile safe.
 */

/** Profiles that take no argument. */
export const PERF_SEED_FIXED_PROFILES = [
  "large-stream",
  "thread-100",
  "thread-500",
  "thread-2000",
  "drafts",
  "board-large",
  "workspace-wide",
] as const

export type PerfSeedFixedProfile = (typeof PERF_SEED_FIXED_PROFILES)[number]

/** The one parameterised profile: `missed-entries=<N>`. */
export const PERF_SEED_PARAMETERISED_PROFILE = "missed-entries"

/**
 * Batch-sizing heuristic only — NOT an exact factor. A posted message writes at
 * least three sync-log entries (message projection, the user-scoped
 * `activity:created` row, and the conversation attach's two stream-scoped rows),
 * and the real count is workload-dependent. The driver measures the actual
 * sync-log head delta and stops when it reaches the requested count; this
 * constant only decides how many messages a batch posts before re-reading.
 */
export const SYNC_LOG_ENTRIES_PER_MESSAGE = 3

/** Draft body sizes staged by the `drafts` profile, in characters of body text. */
export const DRAFT_PROFILE_SIZES = [1_024, 10_240, 102_400, 262_144] as const

/** Messages seeded into every `board-large` channel so each board row has content. */
export const BOARD_LARGE_MESSAGES_PER_STREAM = 3

/**
 * Channels seeded by `board-large`. The board fans out its per-stream sync with
 * `BOARD_SYNC_CONCURRENCY = 6` lanes (`apps/frontend/src/sync/sync-engine.ts`),
 * so four full waves is the smallest count that makes lane queueing — not lane
 * width — the thing under observation.
 */
export const BOARD_LARGE_STREAM_COUNT = 24

/**
 * Channels seeded by `workspace-wide`. Above 50 so a bootstrap apply crosses
 * Dexie 4.4.2's FULL_RANGE threshold (`dist/dexie.js:5736`) in `streams` AND in
 * `streamMemberships` — a `bulkPut` of ≥50 values invalidates every key range on
 * the table, waking every live query. `board-large`'s 24 never crosses it, so no
 * existing profile can show the bootstrap diff removing that amplifier.
 */
export const WORKSPACE_WIDE_STREAM_COUNT = 60

/**
 * One message per `workspace-wide` channel, so every stream row carries a
 * `lastMessagePreview` — the field D16 names as the diff's honest floor.
 */
export const WORKSPACE_WIDE_MESSAGES_PER_STREAM = 1

export interface ParsedProfile {
  readonly name: PerfSeedFixedProfile | typeof PERF_SEED_PARAMETERISED_PROFILE
  /** Requested sync-log entry count; only set for `missed-entries`. */
  readonly entries?: number
}

/**
 * A stream the profile requires. `key` is deterministic: it is both the channel
 * slug and the marker prefix for messages seeded into it, which is what lets a
 * re-run recognise its own earlier work.
 */
export interface PlannedStreamSlot {
  readonly key: string
  readonly kind: "channel" | "thread"
  /** Channel slot key this thread hangs off. Threads only. */
  readonly parentKey?: string
  /** Marker-bearing messages this slot must hold when seeding is done. */
  readonly messageTarget: number
}

export interface PlannedDraft {
  readonly key: string
  /** Characters of body text staged in the draft. */
  readonly chars: number
}

export interface PerfSeedSpec {
  readonly profile: string
  readonly slots: readonly PlannedStreamSlot[]
  readonly drafts: readonly PlannedDraft[]
}

/**
 * What the workspace already holds. A slot key absent from `messageCounts`
 * means the stream itself does not exist yet; `0` means it exists and is empty.
 */
export interface ExistingState {
  readonly messageCounts: Readonly<Record<string, number | undefined>>
  readonly draftKeys?: readonly string[]
}

export type SeedOperation =
  | {
      readonly kind: "createStream"
      readonly key: string
      readonly streamKind: "channel" | "thread"
      readonly parentKey?: string
    }
  | { readonly kind: "postMessages"; readonly key: string; readonly from: number; readonly count: number }
  | {
      /**
       * Post into `key` until the workspace sync head has advanced by at least
       * `entries`. Message bodies carry `runMarker`, which is unique per
       * invocation, so repeating the profile opens a fresh gap instead of
       * short-circuiting on its own earlier rows.
       */
      readonly kind: "advanceSyncLog"
      readonly key: string
      readonly entries: number
      readonly runMarker: string
    }
  | { readonly kind: "upsertDraft"; readonly key: string; readonly chars: number }

export class UnknownPerfProfileError extends Error {
  constructor(raw: string) {
    super(
      `Unknown perf-seed profile "${raw}". Known: ${[...PERF_SEED_FIXED_PROFILES, `${PERF_SEED_PARAMETERISED_PROFILE}=<N>`].join(", ")}`
    )
    this.name = "UnknownPerfProfileError"
  }
}

/** `--profile large-stream` / `--profile missed-entries=200`. Throws on anything else (INV-11). */
export function parseProfile(raw: string): ParsedProfile {
  const trimmed = raw.trim()
  if ((PERF_SEED_FIXED_PROFILES as readonly string[]).includes(trimmed)) {
    return { name: trimmed as PerfSeedFixedProfile }
  }

  const match = /^missed-entries=(\d+)$/.exec(trimmed)
  if (match) {
    const entries = Number(match[1])
    // 100k entries is far above any collapse-boundary experiment; anything
    // bigger is a typo, not a fixture.
    if (entries <= 0 || entries > 100_000) throw new UnknownPerfProfileError(raw)
    return { name: PERF_SEED_PARAMETERISED_PROFILE, entries }
  }

  throw new UnknownPerfProfileError(raw)
}

/** Messages a batch posts before re-reading the head. Heuristic, never a promise. */
export function messagesForMissedEntries(entries: number): number {
  return Math.max(1, Math.ceil(entries / SYNC_LOG_ENTRIES_PER_MESSAGE))
}

function threadSpec(profile: PerfSeedFixedProfile, replies: number): PerfSeedSpec {
  const channelKey = `perf-${profile}`
  return {
    profile,
    slots: [
      // The thread anchor is a real message in the parent channel.
      { key: channelKey, kind: "channel", messageTarget: 1 },
      { key: `${channelKey}-thread`, kind: "thread", parentKey: channelKey, messageTarget: replies },
    ],
    drafts: [],
  }
}

/** What a profile wants, independent of what already exists. */
export function seedSpec(profile: ParsedProfile): PerfSeedSpec {
  switch (profile.name) {
    case "large-stream":
      return {
        profile: "large-stream",
        slots: [{ key: "perf-large-stream", kind: "channel", messageTarget: 5_000 }],
        drafts: [],
      }
    case "thread-100":
      return threadSpec("thread-100", 100)
    case "thread-500":
      return threadSpec("thread-500", 500)
    case "thread-2000":
      return threadSpec("thread-2000", 2_000)
    case "missed-entries": {
      const entries = profile.entries
      if (entries === undefined) throw new UnknownPerfProfileError("missed-entries")
      // The channel is reused across runs; the gap comes from the head delta the
      // driver measures, so the slot itself has no message target.
      return {
        profile: `missed-entries=${entries}`,
        slots: [{ key: "perf-missed-entries", kind: "channel", messageTarget: 0 }],
        drafts: [],
      }
    }
    case "drafts":
      // A draft is keyed by scope (`stream:<id>`), so the four sizes need four
      // host channels rather than four drafts in one.
      return {
        profile: "drafts",
        slots: DRAFT_PROFILE_SIZES.map((chars) => ({
          key: `perf-draft-${chars}`,
          kind: "channel" as const,
          messageTarget: 0,
        })),
        drafts: DRAFT_PROFILE_SIZES.map((chars) => ({ key: `perf-draft-${chars}`, chars })),
      }
    case "board-large":
      return {
        profile: "board-large",
        slots: Array.from({ length: BOARD_LARGE_STREAM_COUNT }, (_, i) => ({
          key: `perf-board-${String(i + 1).padStart(2, "0")}`,
          kind: "channel" as const,
          messageTarget: BOARD_LARGE_MESSAGES_PER_STREAM,
        })),
        drafts: [],
      }
    case "workspace-wide":
      return {
        profile: "workspace-wide",
        slots: Array.from({ length: WORKSPACE_WIDE_STREAM_COUNT }, (_, i) => ({
          key: `perf-wide-${String(i + 1).padStart(2, "0")}`,
          kind: "channel" as const,
          messageTarget: WORKSPACE_WIDE_MESSAGES_PER_STREAM,
        })),
        drafts: [],
      }
  }
}

/**
 * The operations still outstanding for `profile` given `existing`. Re-running a
 * fully-seeded profile plans nothing; a partial seed plans only the remainder.
 * `missed-entries` is the exception: it always plans work, and needs the
 * caller's per-run marker (an input, so this module stays pure).
 */
export function planSeed(profile: ParsedProfile, existing: ExistingState, runMarker?: string): SeedOperation[] {
  const spec = seedSpec(profile)
  const operations: SeedOperation[] = []

  for (const slot of spec.slots) {
    const have = existing.messageCounts[slot.key]
    if (have === undefined) {
      operations.push({
        kind: "createStream",
        key: slot.key,
        streamKind: slot.kind,
        ...(slot.parentKey ? { parentKey: slot.parentKey } : {}),
      })
    }
    const seeded = have ?? 0
    if (seeded < slot.messageTarget) {
      operations.push({ kind: "postMessages", key: slot.key, from: seeded + 1, count: slot.messageTarget - seeded })
    }
  }

  if (profile.name === PERF_SEED_PARAMETERISED_PROFILE) {
    const entries = profile.entries
    if (entries === undefined) throw new UnknownPerfProfileError("missed-entries")
    if (!runMarker) throw new Error("planSeed needs a runMarker for missed-entries — each run must open a fresh gap.")
    operations.push({ kind: "advanceSyncLog", key: spec.slots[0]!.key, entries, runMarker })
  }

  const draftKeys = new Set(existing.draftKeys ?? [])
  for (const draft of spec.drafts) {
    if (!draftKeys.has(draft.key)) operations.push({ kind: "upsertDraft", key: draft.key, chars: draft.chars })
  }

  return operations
}

/** Deterministic message body. The `key` prefix is the marker a re-run counts on. */
export function messageContent(key: string, ordinal: number): string {
  return `${key} #${String(ordinal).padStart(5, "0")}`
}
