import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Pool } from "pg"
import { ActivityTypes } from "@threahq/types"
import { ActivityRepository } from "../../src/features/activity"
import { UserRepository, WorkspaceRepository } from "../../src/features/workspaces"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase } from "./setup"

describe("activity for user copies", () => {
  let pool: Pool

  beforeAll(async () => {
    pool = await setupTestDatabase()
  })

  afterAll(async () => {
    await pool.end()
  })

  async function insertWorkspace(name: string) {
    const id = workspaceId()
    const ownerWorkosUserId = userId()
    await WorkspaceRepository.insert(pool, {
      id,
      name,
      slug: `${name.toLowerCase()}-${id}`,
      createdBy: ownerWorkosUserId,
    })
    return { id, ownerWorkosUserId }
  }

  /**
   * A partner workspace with one local member and a copy of a host user, who
   * stays a local member of the host under the same id.
   */
  async function seed() {
    const host = await insertWorkspace("Host")
    const partner = await insertWorkspace("Partner")
    const wsId = partner.id
    const hostAdmin = await addTestMember(pool, host.id, host.ownerWorkosUserId, "owner")
    const local = await addTestMember(pool, wsId, partner.ownerWorkosUserId, "owner")
    const copy = (await UserRepository.insertCopy(pool, {
      id: hostAdmin.id,
      workspaceId: wsId,
      originWorkspaceId: host.id,
      name: hostAdmin.name,
      slug: `host-admin-${wsId}`,
    }))!
    const activity = {
      workspaceId: wsId,
      activityType: ActivityTypes.MENTION,
      streamId: streamId(),
      messageId: messageId(),
      actorId: copy.id,
      actorType: "user",
    }
    return { hostId: host.id, local, copy, activity }
  }

  test("should write activity for local members only when a batch names a user copy", async () => {
    const { local, copy, activity } = await seed()

    const rows = await ActivityRepository.insertBatch(pool, { ...activity, userIds: [local.id, copy.id] })

    expect(rows.map((row) => row.userId)).toEqual([local.id])
  })

  test("should write activity for the host's own user when a partner holds a copy of them", async () => {
    const { hostId, copy, activity } = await seed()
    const inHost = { ...activity, workspaceId: hostId }

    const batch = await ActivityRepository.insertBatch(pool, { ...inHost, userIds: [copy.id] })
    const single = await ActivityRepository.insert(pool, { ...inHost, messageId: messageId(), userId: copy.id })

    expect({ batch: batch.map((row) => row.userId), single: single?.userId }).toEqual({
      batch: [copy.id],
      single: copy.id,
    })
  })

  test("should write no activity when a single row is for a user copy", async () => {
    const { local, copy, activity } = await seed()

    const forCopy = await ActivityRepository.insert(pool, { ...activity, userId: copy.id })
    const forLocal = await ActivityRepository.insert(pool, { ...activity, userId: local.id })

    expect({ forCopy, forLocal: forLocal?.userId }).toEqual({ forCopy: null, forLocal: local.id })
  })
})
