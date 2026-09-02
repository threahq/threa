/**
 * Subagent threads inherit access, they never carry it (INV-62).
 *
 * The card lives in the parent stream and the conversation lives in a thread
 * anchored on it, so "who can see the subagent" is decided entirely by the root:
 * a private channel's non-member reaches neither, and a channel member reaches
 * the thread WITHOUT a `stream_members` row on it — the case the invariant
 * requires a test for, and the one a membership-based filter silently breaks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamMemberRepository, checkStreamAccess, listAccessibleStreamIds } from "../../src/features/streams"
import { SubagentService } from "../../src/features/subagents"
import { setupIsolatedTestDatabase } from "./setup"
import { createParams, createSubagentTestContext, type SubagentTestContext } from "./subagent-support"

let pool: Pool
let cleanup: () => Promise<void>
let ctx: SubagentTestContext
let subagentService: SubagentService

beforeAll(async () => {
  const db = await setupIsolatedTestDatabase("subagent-access")
  pool = db.pool
  cleanup = db.cleanup
  ctx = await createSubagentTestContext(pool, "access")
  subagentService = new SubagentService({ pool, streamService: ctx.streamService })
})

afterAll(async () => {
  await cleanup()
})

describe("private channel", () => {
  test("a channel member reads the thread with no membership row on it", async () => {
    const channel = await ctx.createChannel({
      slug: "private-inherit",
      visibility: "private",
      memberIds: [ctx.owner, ctx.member],
    })
    const { threadStreamId } = await subagentService.create(createParams(ctx, channel.id))

    // The delegating user created the thread and is a member of it; `member` is
    // only in the channel — access must come from the root, not the thread.
    expect(await StreamMemberRepository.isMember(pool, threadStreamId, ctx.member)).toBe(false)
    expect(await checkStreamAccess(pool, threadStreamId, ctx.workspaceId, ctx.member)).toMatchObject({
      id: threadStreamId,
      rootStreamId: channel.id,
    })
    expect(await listAccessibleStreamIds(pool, ctx.workspaceId, ctx.member, [channel.id, threadStreamId])).toEqual(
      new Set([channel.id, threadStreamId])
    )
  })

  test("a non-member reaches neither the card's stream nor the thread", async () => {
    const channel = await ctx.createChannel({
      slug: "private-hidden",
      visibility: "private",
      memberIds: [ctx.owner, ctx.member],
    })
    const { threadStreamId } = await subagentService.create(createParams(ctx, channel.id))

    expect(await checkStreamAccess(pool, channel.id, ctx.workspaceId, ctx.outsider)).toBeNull()
    expect(await checkStreamAccess(pool, threadStreamId, ctx.workspaceId, ctx.outsider)).toBeNull()
    expect(await listAccessibleStreamIds(pool, ctx.workspaceId, ctx.outsider, [channel.id, threadStreamId])).toEqual(
      new Set()
    )
  })

  test("access is workspace-scoped: another workspace's user id resolves to nothing (INV-8)", async () => {
    const channel = await ctx.createChannel({
      slug: "private-workspace",
      visibility: "private",
      memberIds: [ctx.owner],
    })
    const { threadStreamId } = await subagentService.create(createParams(ctx, channel.id))

    expect(await checkStreamAccess(pool, threadStreamId, "ws_someone_else", ctx.owner)).toBeNull()
    expect(
      await subagentService.findActiveByThreadStream({ workspaceId: "ws_someone_else", threadStreamId })
    ).toBeNull()
  })
})

describe("public channel", () => {
  test("every workspace member reads the thread without joining anything", async () => {
    const channel = await ctx.createChannel({ slug: "public-inherit", memberIds: [ctx.owner] })
    const { threadStreamId } = await subagentService.create(createParams(ctx, channel.id))

    expect(await StreamMemberRepository.isMember(pool, channel.id, ctx.outsider)).toBe(false)
    expect(await StreamMemberRepository.isMember(pool, threadStreamId, ctx.outsider)).toBe(false)
    expect(await checkStreamAccess(pool, threadStreamId, ctx.workspaceId, ctx.outsider)).toMatchObject({
      id: threadStreamId,
      visibility: "public",
    })
  })
})
