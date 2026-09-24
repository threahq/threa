/**
 * A sandbox token reads what the agent could read in its turn, and only while
 * the invoking user still can:
 *
 * - a non-member thread inside a member channel is readable (INV-62)
 * - a captured stream the user cannot read stays unreadable (capture never widens)
 * - a stream the user can read but the turn did not capture stays unreadable
 * - losing access mid-run removes the stream on the next call
 * - E2EE-rooted streams and their threads are never readable
 * - revoked and expired tokens stop validating
 * - expired rows are kept a day, then deleted
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import { addTestMember, setupTestDatabase, withTransaction } from "./setup"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamMemberRepository, StreamRepository } from "../../src/features/streams"
import { E2eStreamsRepository } from "../../src/features/e2e-streams"
import {
  SandboxSessionTokenService,
  isSandboxStreamReadable,
  sandboxReadableStreamIds,
  type SandboxSession,
} from "../../src/features/sandboxes"
import { messageId, personaId, sessionId, streamId, userId, workspaceId } from "../../src/lib/id"

describe("sandbox session tokens", () => {
  let pool: Pool
  let service: SandboxSessionTokenService
  let ws: string
  let invokerId: string
  let otherId: string
  const channel = streamId()
  const nonMemberThread = streamId()
  const otherDm = streamId()
  const uncaptured = streamId()
  const revocable = streamId()
  const e2eRoot = streamId()
  const e2eThread = streamId()

  type Client = Parameters<typeof StreamRepository.insert>[0]

  async function insertStream(client: Client, id: string, type: string, createdBy: string, rootId?: string) {
    await StreamRepository.insert(client, {
      id,
      workspaceId: ws,
      type,
      visibility: Visibilities.PRIVATE,
      slug: type === StreamTypes.CHANNEL ? `s-${id.slice(-10)}` : undefined,
      createdBy,
      ...(rootId ? { parentStreamId: rootId, parentAnchorId: messageId(), rootStreamId: rootId } : {}),
    })
  }

  function mint(capturedStreamIds: string[], ttlSec = 60) {
    return service.mint({
      workspaceId: ws,
      invokingUserId: invokerId,
      personaId: personaId(),
      sessionId: sessionId(),
      streamId: channel,
      capturedStreamIds,
      ttlSec,
    })
  }

  beforeAll(async () => {
    pool = await setupTestDatabase()
    service = new SandboxSessionTokenService({ pool })
    ws = workspaceId()
    await withTransaction(pool, async (client) => {
      await WorkspaceRepository.insert(client, {
        id: ws,
        name: "Sandbox tokens",
        slug: `sst-${ws}`,
        createdBy: userId(),
      })
      invokerId = (await addTestMember(client, ws, userId())).id
      otherId = (await addTestMember(client, ws, userId())).id
      const thirdId = (await addTestMember(client, ws, userId())).id

      await insertStream(client, channel, StreamTypes.CHANNEL, invokerId)
      await insertStream(client, nonMemberThread, StreamTypes.THREAD, otherId, channel)
      await insertStream(client, otherDm, StreamTypes.DM, otherId)
      await insertStream(client, uncaptured, StreamTypes.CHANNEL, invokerId)
      await insertStream(client, revocable, StreamTypes.CHANNEL, invokerId)
      await insertStream(client, e2eRoot, StreamTypes.CHANNEL, invokerId)
      await insertStream(client, e2eThread, StreamTypes.THREAD, invokerId, e2eRoot)

      for (const id of [channel, uncaptured, revocable, e2eRoot]) {
        await StreamMemberRepository.insert(client, id, invokerId)
      }
      await StreamMemberRepository.insert(client, otherDm, otherId)
      await StreamMemberRepository.insert(client, otherDm, thirdId)

      await E2eStreamsRepository.markStreamE2e(client, {
        streamId: e2eRoot,
        workspaceId: ws,
        ownerUserId: invokerId,
        ownerUserKeyId: "e2ek_test",
      })
    })
  })

  afterAll(async () => {
    await pool.end()
  })

  test("should read the captured streams the invoker can read, including a non-member thread", async () => {
    const { session, value } = await mint([channel, nonMemberThread, otherDm, revocable, e2eRoot, e2eThread])
    const validated = (await service.validate(value)) as SandboxSession
    expect(validated).toEqual(session)

    expect(new Set(await sandboxReadableStreamIds(pool, validated))).toEqual(
      new Set([channel, nonMemberThread, revocable])
    )
    expect(await isSandboxStreamReadable(pool, validated, nonMemberThread)).toBe(true)
    expect(await isSandboxStreamReadable(pool, validated, otherDm)).toBe(false)
    expect(await isSandboxStreamReadable(pool, validated, uncaptured)).toBe(false)
    expect(await isSandboxStreamReadable(pool, validated, e2eRoot)).toBe(false)
    expect(await isSandboxStreamReadable(pool, validated, e2eThread)).toBe(false)
  })

  test("should drop a stream on the next call once the invoker loses access", async () => {
    const { value } = await mint([channel, revocable])
    const session = (await service.validate(value)) as SandboxSession
    expect(await isSandboxStreamReadable(pool, session, revocable)).toBe(true)

    await StreamMemberRepository.delete(pool, revocable, invokerId)

    expect(await isSandboxStreamReadable(pool, session, revocable)).toBe(false)
    expect(await sandboxReadableStreamIds(pool, session)).toEqual([channel])
  })

  test("should stop validating once revoked or expired", async () => {
    const live = await mint([channel])
    expect(await service.validate(live.value)).not.toBeNull()
    await service.revoke(ws, live.session.id)
    expect(await service.validate(live.value)).toBeNull()

    const expired = await mint([channel], -1)
    expect(await service.validate(expired.value)).toBeNull()

    expect(await service.validate("threa_sk_not-a-token")).toBeNull()
    expect(await service.validate(`threa_uk_${live.value.slice(9)}`)).toBeNull()
  })

  test("should delete rows a day past expiry at the next mint and keep recently expired ones", async () => {
    const stale = await mint([channel], -(24 * 60 * 60 + 60))
    const recent = await mint([channel], -60)

    await mint([channel])

    const left = await pool.query<{ id: string }>(`SELECT id FROM sandbox_session_tokens WHERE id = ANY($1)`, [
      [stale.session.id, recent.session.id],
    ])
    expect(left.rows.map((row) => row.id)).toEqual([recent.session.id])
  })
})
