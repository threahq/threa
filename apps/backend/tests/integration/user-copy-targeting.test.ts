import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Pool } from "pg"
import { StreamTypes, Visibilities } from "@threahq/types"
import { ActivityService } from "../../src/features/activity"
import { buildMentionResolutionMaps } from "../../src/features/mentions"
import { StreamMemberRepository, StreamRepository, StreamService } from "../../src/features/streams"
import { PeoplePurposes, UserRepository, WorkspaceRepository, type PeopleScope } from "../../src/features/workspaces"
import { messageId, streamId, userId, workspaceId } from "../../src/lib/id"
import { addTestMember, setupTestDatabase } from "./setup"

describe("host user copies in a partner workspace", () => {
  let pool: Pool
  let streamService: StreamService
  let activityService: ActivityService

  beforeAll(async () => {
    pool = await setupTestDatabase()
    streamService = new StreamService(pool)
    activityService = new ActivityService({ pool })
  })

  afterAll(async () => {
    await pool.end()
  })

  /** A partner workspace with a local owner, a local member, and a copy of a host user. */
  async function seed() {
    const wsId = workspaceId()
    const ownerWorkosUserId = userId()
    await WorkspaceRepository.insert(pool, {
      id: wsId,
      name: "Partner",
      slug: `partner-${wsId}`,
      createdBy: ownerWorkosUserId,
    })
    const owner = await addTestMember(pool, wsId, ownerWorkosUserId, "owner")
    // Mention resolution matches slugs lowercased, as real slugs are.
    const slugSuffix = wsId.toLowerCase()
    const added = await addTestMember(pool, wsId, userId())
    const member = (await UserRepository.update(pool, wsId, added.id, { slug: `mia-${slugSuffix}` }))!
    const copy = (await UserRepository.insertCopy(pool, {
      id: userId(),
      workspaceId: wsId,
      originWorkspaceId: workspaceId(),
      name: "Hosted Hazel",
      slug: `hazel-host-${slugSuffix}`,
    }))!
    return { wsId, owner, member, copy }
  }

  test("should leave a copy out of targetable reads and keep it in visible reads", async () => {
    const { wsId, owner, copy } = await seed()
    const read = async (purpose: PeopleScope["purpose"]) => {
      const scope: PeopleScope = { viewer: { kind: "user", userId: owner.id }, purpose }
      return {
        listed: (await UserRepository.listByWorkspace(pool, wsId, scope)).some((user) => user.id === copy.id),
        bySlugs: (await UserRepository.findBySlugs(pool, wsId, [copy.slug], scope)).length > 0,
        searched: (await UserRepository.searchByNameOrSlug(pool, wsId, "Hosted Hazel", 10, scope)).length > 0,
        byIds: (await UserRepository.findByIds(pool, wsId, [copy.id], scope)).length > 0,
        byId: (await UserRepository.findById(pool, wsId, copy.id, scope)) !== null,
      }
    }

    expect({
      targetable: await read(PeoplePurposes.TARGETABLE),
      visible: await read(PeoplePurposes.VISIBLE),
      originWorkspaceId: (await UserRepository.findById(pool, wsId, copy.id))?.originWorkspaceId,
    }).toEqual({
      targetable: { listed: false, bySlugs: false, searched: false, byIds: false, byId: false },
      visible: { listed: true, bySlugs: true, searched: true, byIds: true, byId: true },
      originWorkspaceId: copy.originWorkspaceId,
    })
  })

  test("should refuse a DM with a copy when a partner member opens one", async () => {
    const { wsId, owner, copy } = await seed()

    await expect(
      streamService.findOrCreateDm({ workspaceId: wsId, userOneId: owner.id, userTwoId: copy.id })
    ).rejects.toMatchObject({ status: 404, code: "MEMBER_NOT_FOUND" })
  })

  test("should refuse adding a copy to a channel when a partner member adds them", async () => {
    const { wsId, owner, copy } = await seed()
    const channel = await streamService.createChannel({
      workspaceId: wsId,
      slug: `local-${streamId()}`,
      createdBy: owner.id,
      visibility: Visibilities.PUBLIC,
    })

    await expect(streamService.addMember(channel.id, copy.id, wsId, owner.id)).rejects.toMatchObject({
      status: 404,
      code: "MEMBER_NOT_FOUND",
    })
  })

  test("should not resolve a bare mention slug to a copy", async () => {
    const { wsId, owner, member, copy } = await seed()

    const maps = await buildMentionResolutionMaps(
      pool,
      wsId,
      { mentionSlugs: [copy.slug, member.slug], channelSlugs: [] },
      { kind: "user", userId: owner.id }
    )

    expect([...maps.mentionSlugToActor.keys()]).toEqual([member.slug])
  })

  test("should notify the partner's members when a copied host message mentions the channel", async () => {
    const { wsId, owner, member, copy } = await seed()
    const copyStreamId = streamId()
    await StreamRepository.insert(pool, {
      id: copyStreamId,
      workspaceId: wsId,
      type: StreamTypes.CHANNEL,
      slug: `shared-${copyStreamId}`,
      visibility: Visibilities.PRIVATE,
      originWorkspaceId: copy.originWorkspaceId,
      createdBy: owner.id,
    })
    await StreamMemberRepository.insertMany(pool, wsId, copyStreamId, [owner.id, member.id])

    const activities = await activityService.processMessageMentions({
      workspaceId: wsId,
      streamId: copyStreamId,
      messageId: messageId(),
      actorId: copy.id,
      actorType: "user",
      contentMarkdown: "@channel heads up",
      contentJson: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { id: "broadcast:channel", slug: "channel", mentionType: "broadcast" } },
              { type: "text", text: " heads up" },
            ],
          },
        ],
      },
    })

    expect(activities.map((activity) => activity.userId).sort()).toEqual([owner.id, member.id].sort())
  })
})
