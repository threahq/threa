import { describe, expect, it } from "bun:test"
import { WORKSPACE_PERMISSION_SCOPES, LabelableResourceTypes, Visibilities, StreamTypes } from "@threahq/types"
import {
  resolveDeliveryGroups,
  permissionGroupsForRole,
  permissionGroup,
  streamGroup,
  userGroup,
  BROWSE_GROUP,
  WORKSPACE_GROUP,
} from "./delivery-groups"
import type { OutboxEvent, OutboxEventType } from "./repository"

function event<T extends OutboxEventType>(eventType: T, payload: Record<string, unknown>): OutboxEvent<T> {
  return { id: 1n, eventType, payload, createdAt: new Date() } as unknown as OutboxEvent<T>
}

const MEMBERS_WRITE_GROUP = permissionGroup(WORKSPACE_PERMISSION_SCOPES.MEMBERS_WRITE)
const WORKSPACE_ADMIN_GROUP = permissionGroup(WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)

/** The workspace-wide groups an open stream's events reach, by the stream's visibility. */
const OPEN_AUDIENCE = {
  [Visibilities.PUBLIC]: [BROWSE_GROUP],
  [Visibilities.GUEST_PUBLIC]: [WORKSPACE_GROUP],
  [Visibilities.PRIVATE]: [],
} as const
const VISIBILITIES = [Visibilities.PUBLIC, Visibilities.GUEST_PUBLIC, Visibilities.PRIVATE] as const

describe("permissionGroup", () => {
  it("names the members:write delivery group on the wire", () => {
    // Pins the group string format once; other suites derive via the helper.
    expect(MEMBERS_WRITE_GROUP).toBe("permission:members:write")
  })
})

describe("resolveDeliveryGroups — internal events", () => {
  it("keeps dynamic naming requests out of client delivery", () => {
    expect(
      resolveDeliveryGroups(
        event("dynamic_naming:requested", {
          workspaceId: "ws_1",
          targetKind: "stream",
          targetId: "stream_1",
          deferred: false,
        })
      )
    ).toEqual([])
  })
})

describe("resolveDeliveryGroups — stream:created thread routing", () => {
  it("routes to the parent's stream group named by the created thread", () => {
    const groups = resolveDeliveryGroups(
      event("stream:created", {
        workspaceId: "ws_1",
        streamId: "stream_thread",
        stream: {
          id: "stream_thread",
          type: StreamTypes.THREAD,
          parentAnchorId: "msg_1",
          parentStreamId: "stream_parent",
        },
      })
    )
    expect(groups).toEqual([streamGroup("stream_parent")])
  })

  it("falls back to streamId when the payload's stream carries no parent (legacy shape)", () => {
    const groups = resolveDeliveryGroups(
      event("stream:created", {
        workspaceId: "ws_1",
        streamId: "stream_parent",
        stream: { id: "stream_thread", type: StreamTypes.THREAD, parentAnchorId: "msg_1" },
      })
    )
    expect(groups).toEqual([streamGroup("stream_parent")])
  })
})

describe("resolveDeliveryGroups — stream:created audience", () => {
  for (const visibility of VISIBILITIES) {
    it(`should reach the open audience and the creator when the channel is ${visibility}`, () => {
      const groups = resolveDeliveryGroups(
        event("stream:created", {
          workspaceId: "ws_1",
          streamId: "stream_1",
          stream: { id: "stream_1", type: StreamTypes.CHANNEL, visibility, createdBy: "usr_creator" },
        })
      )
      expect(groups).toEqual([...OPEN_AUDIENCE[visibility], userGroup("usr_creator")])
    })
  }
})

describe("resolveDeliveryGroups — stream:updated audience", () => {
  const route = (visibility: string) =>
    resolveDeliveryGroups(
      event("stream:updated", { workspaceId: "ws_1", streamId: "stream_1", stream: { id: "stream_1", visibility } })
    )

  it("should reach browsers and the stream's room when the channel is public", () => {
    expect(route(Visibilities.PUBLIC)).toEqual([BROWSE_GROUP, streamGroup("stream_1")])
  })

  it("should reach the whole workspace and the stream's room when the channel is guest_public", () => {
    expect(route(Visibilities.GUEST_PUBLIC)).toEqual([WORKSPACE_GROUP, streamGroup("stream_1")])
  })

  it("should keep guests out of the workspace-wide delivery when the channel is private", () => {
    expect(route(Visibilities.PRIVATE)).toEqual([BROWSE_GROUP, streamGroup("stream_1")])
  })

  it("should keep guests out of the workspace-wide delivery when a thread carries a guest_public copy", () => {
    expect(
      resolveDeliveryGroups(
        event("stream:updated", {
          workspaceId: "ws_1",
          streamId: "stream_thread",
          stream: { id: "stream_thread", visibility: Visibilities.GUEST_PUBLIC, rootStreamId: "stream_1" },
        })
      )
    ).toEqual([BROWSE_GROUP, streamGroup("stream_thread")])
  })
})

describe("resolveDeliveryGroups — stream:display_name_updated audience", () => {
  for (const visibility of VISIBILITIES) {
    it(`should reach the open audience and the stream's room when the stream is ${visibility}`, () => {
      const groups = resolveDeliveryGroups(
        event("stream:display_name_updated", {
          workspaceId: "ws_1",
          streamId: "stream_1",
          displayName: "Launch",
          visibility,
          source: "user",
          revision: 2,
        })
      )
      expect(groups).toEqual([...OPEN_AUDIENCE[visibility], streamGroup("stream_1")])
    })
  }
})

describe("resolveDeliveryGroups — workspace people and guest-safe events", () => {
  const user = { id: "usr_1" }

  it("should reach browsers and the user themselves when a workspace user is added or updated", () => {
    for (const eventType of ["workspace_user:added", "workspace_user:updated"] as const) {
      expect(resolveDeliveryGroups(event(eventType, { workspaceId: "ws_1", user }))).toEqual([
        BROWSE_GROUP,
        userGroup("usr_1"),
      ])
    }
  })

  it("should reach browsers and the removed user when a workspace user is removed", () => {
    expect(
      resolveDeliveryGroups(event("workspace_user:removed", { workspaceId: "ws_1", removedUserId: "usr_1" }))
    ).toEqual([BROWSE_GROUP, userGroup("usr_1")])
  })

  it("should reach the whole workspace when the event is listed as guest-safe", () => {
    for (const eventType of ["workspace_settings:updated", "feature_flags:workspace_updated"] as const) {
      expect(resolveDeliveryGroups(event(eventType, { workspaceId: "ws_1" }))).toEqual([WORKSPACE_GROUP])
    }
  })

  it("should reach the whole workspace when the bot is shared", () => {
    for (const eventType of ["bot:created", "bot:updated"] as const) {
      expect(
        resolveDeliveryGroups(event(eventType, { workspaceId: "ws_1", bot: { type: "shared", ownerUserId: null } }))
      ).toEqual([WORKSPACE_GROUP])
    }
  })

  it("should reach browsers and the owner only when the bot is personal", () => {
    for (const eventType of ["bot:created", "bot:updated"] as const) {
      expect(
        resolveDeliveryGroups(
          event(eventType, { workspaceId: "ws_1", bot: { type: "personal", ownerUserId: "usr_owner" } })
        )
      ).toEqual([BROWSE_GROUP, userGroup("usr_owner")])
    }
  })

  it("should reach browsers only when an event has no explicit routing", () => {
    expect(resolveDeliveryGroups(event("attachment:uploaded", { workspaceId: "ws_1" }))).toEqual([BROWSE_GROUP])
  })
})

describe("resolveDeliveryGroups — invitation events", () => {
  const invitationEvents = [
    "invitation:sent",
    "invitation:accepted",
    "invitation:revoked",
    "invitation:link-created",
    "invitation:link-claimed",
  ] as const

  for (const eventType of invitationEvents) {
    it(`scopes ${eventType} to members:write, never the workspace`, () => {
      const groups = resolveDeliveryGroups(event(eventType, { workspaceId: "ws_1", invitationId: "inv_1" }))
      expect(groups).toEqual([MEMBERS_WRITE_GROUP])
      expect(groups).not.toContain("workspace")
    })
  }
})

describe("resolveDeliveryGroups — enclave re-wrap nudges", () => {
  it("routes the socket nudge to the owner only — only they can re-wrap", () => {
    const groups = resolveDeliveryGroups(
      event("e2e:rewrap_needed", { workspaceId: "ws_1", targetUserId: "usr_owner", rootStreamId: "stream_1" })
    )
    expect(groups).toEqual([userGroup("usr_owner")])
    expect(groups).not.toContain("workspace")
  })

  it("keeps the web-push nudge off the wire (null) — it's the push handler's, never a broadcast", () => {
    const groups = resolveDeliveryGroups(
      event("e2e:rewrap_nudge", { workspaceId: "ws_1", targetUserId: "usr_owner", rootStreamId: "stream_1" })
    )
    // Null = not broadcast and not sync-logged (it would otherwise fall through
    // to the workspace-wide default and leak a per-owner signal to everyone).
    expect(groups).toBeNull()
  })
})

describe("resolveDeliveryGroups — agent sessions", () => {
  it("routes thread lifecycle events to the thread and its access root", () => {
    expect(
      resolveDeliveryGroups(
        event("agent_session:started", {
          workspaceId: "ws_1",
          streamId: "stream_thread",
          rootStreamId: "stream_root",
          event: {},
        })
      )
    ).toEqual([streamGroup("stream_thread"), streamGroup("stream_root")])
  })

  it("does not duplicate a root session's delivery group", () => {
    expect(
      resolveDeliveryGroups(
        event("agent_session:completed", {
          workspaceId: "ws_1",
          streamId: "stream_root",
          rootStreamId: "stream_root",
          event: {},
        })
      )
    ).toEqual([streamGroup("stream_root")])
  })
})

describe("resolveDeliveryGroups — agent_config:updated (user-scoped-personas)", () => {
  it("routes a personal persona's update to its owner's room only, never the workspace", () => {
    const groups = resolveDeliveryGroups(
      event("agent_config:updated", {
        workspaceId: "ws_1",
        agentId: "persona_personal_1",
        persona: { id: "persona_personal_1", kind: "personal", ownerUserId: "usr_owner" },
      })
    )
    expect(groups).toEqual([userGroup("usr_owner")])
    expect(groups).not.toContain(WORKSPACE_GROUP)
  })

  it("routes a workspace-custom update to the whole workspace (ownerUserId null)", () => {
    const groups = resolveDeliveryGroups(
      event("agent_config:updated", {
        workspaceId: "ws_1",
        agentId: "persona_custom_1",
        persona: { id: "persona_custom_1", kind: "custom", ownerUserId: null },
      })
    )
    expect(groups).toEqual([WORKSPACE_GROUP])
  })

  it("routes a built-in override update to the whole workspace (ownerUserId null)", () => {
    const groups = resolveDeliveryGroups(
      event("agent_config:updated", {
        workspaceId: "ws_1",
        agentId: "persona_system_ariadne",
        persona: { id: "persona_system_ariadne", kind: "builtin", ownerUserId: null },
      })
    )
    expect(groups).toEqual([WORKSPACE_GROUP])
  })
})

describe("resolveDeliveryGroups — board exclusions (hide & mute)", () => {
  it("routes a hide change to the viewer's user group only, never the workspace", () => {
    const groups = resolveDeliveryGroups(
      event("board:conversation_hide_changed", {
        workspaceId: "ws_1",
        targetUserId: "usr_1",
        conversationId: "conv_1",
        active: true,
        hiddenAt: "2026-07-05T00:00:00.000Z",
      })
    )
    expect(groups).toEqual([userGroup("usr_1")])
    expect(groups).not.toContain("workspace")
  })

  it("routes a mute change to the viewer's user group only", () => {
    const groups = resolveDeliveryGroups(
      event("board:stream_mute_changed", {
        workspaceId: "ws_1",
        targetUserId: "usr_1",
        streamId: "stream_1",
        active: true,
      })
    )
    expect(groups).toEqual([userGroup("usr_1")])
  })
})

describe("resolveDeliveryGroups — label assignments", () => {
  // Labels are owner-scoped, so an assignment routes only to the owning actor's
  // user group — never a stream group, even when the labeled resource is a
  // shared channel. The chip is the actor's own organizational layer.
  it("routes a label assignment to its owner's user group, not a stream", () => {
    const groups = resolveDeliveryGroups(
      event("label:assigned", {
        workspaceId: "ws_1",
        targetUserId: "usr_1",
        assignment: { labelId: "label_1", resourceType: LabelableResourceTypes.STREAM, resourceId: "stream_1" },
      })
    )
    expect(groups).toEqual([userGroup("usr_1")])
  })

  it("routes a label unassignment to its owner's user group", () => {
    const groups = resolveDeliveryGroups(
      event("label:unassigned", {
        workspaceId: "ws_1",
        targetUserId: "usr_1",
        labelId: "label_1",
        resourceType: LabelableResourceTypes.STREAM,
        resourceId: "stream_1",
        userId: "usr_1",
      })
    )
    expect(groups).toEqual([userGroup("usr_1")])
  })
})

describe("resolveDeliveryGroups — conversation events (board liveness)", () => {
  for (const visibility of VISIBILITIES) {
    it(`should reach the stream and the open audience when a conversation is created in a ${visibility} channel`, () => {
      const groups = resolveDeliveryGroups(
        event("conversation:created", {
          workspaceId: "ws_1",
          streamId: "stream_1",
          conversationId: "conv_1",
          streamVisibility: visibility,
        })
      )
      expect(groups).toEqual([streamGroup("stream_1"), ...OPEN_AUDIENCE[visibility]])
    })
  }

  it("keeps a private-channel conversation:updated scoped to the stream's members (INV-62)", () => {
    const groups = resolveDeliveryGroups(
      event("conversation:updated", {
        workspaceId: "ws_1",
        streamId: "stream_priv",
        conversationId: "conv_1",
        streamVisibility: Visibilities.PRIVATE,
      })
    )
    expect(groups).toEqual([streamGroup("stream_priv")])
    expect(groups).not.toContain(WORKSPACE_GROUP)
  })

  it("fans a public thread conversation to the thread, its parent channel, and browsers", () => {
    const groups = resolveDeliveryGroups(
      event("conversation:updated", {
        workspaceId: "ws_1",
        streamId: "stream_thread",
        parentStreamId: "stream_pub",
        conversationId: "conv_1",
        streamVisibility: Visibilities.PUBLIC,
      })
    )
    expect(groups).toEqual([streamGroup("stream_thread"), streamGroup("stream_pub"), BROWSE_GROUP])
  })

  it("never broadcasts conversation:message_assigned to the workspace — it carries no board aggregate", () => {
    const groups = resolveDeliveryGroups(
      event("conversation:message_assigned", {
        workspaceId: "ws_1",
        streamId: "stream_thread",
        parentStreamId: "stream_pub",
        messageId: "msg_1",
        conversationId: "conv_1",
        isPrimary: true,
        reason: "declared",
      })
    )
    expect(groups).toEqual([streamGroup("stream_thread"), streamGroup("stream_pub")])
    expect(groups).not.toContain(WORKSPACE_GROUP)
  })
})

describe("resolveDeliveryGroups — call ring lifecycle", () => {
  it("routes call:invitation_created to the invitee's user room only", () => {
    const groups = resolveDeliveryGroups(
      event("call:invitation_created", {
        workspaceId: "ws_1",
        targetUserId: "usr_invitee",
        attemptId: "callinv_1",
        callId: "call_1",
        streamId: "stream_dm",
        inviter: { id: "usr_caller", name: "Ada" },
        mode: "video",
        expiresAt: "2026-07-19T12:00:45.000Z",
      })
    )
    expect(groups).toEqual([userGroup("usr_invitee")])
    expect(groups).not.toContain(WORKSPACE_GROUP)
  })

  it("routes call:invitation_settled to the invitee's user room only (cross-device clear)", () => {
    const groups = resolveDeliveryGroups(
      event("call:invitation_settled", {
        workspaceId: "ws_1",
        targetUserId: "usr_invitee",
        attemptId: "callinv_1",
        callId: "call_1",
        outcome: "accepted",
      })
    )
    expect(groups).toEqual([userGroup("usr_invitee")])
    expect(groups).not.toContain(WORKSPACE_GROUP)
  })
})

describe("resolveDeliveryGroups — stream:message_count", () => {
  const count = (payload: Record<string, unknown>) =>
    new Set(
      resolveDeliveryGroups(
        event("stream:message_count", { workspaceId: "ws_1", messageCount: 3, messageCountRevision: 3, ...payload })
      )
    )

  for (const visibility of VISIBILITIES) {
    it(`should reach the channel's room and the open audience when the channel is ${visibility}`, () => {
      expect(count({ streamId: "stream_1", rootStreamId: null, streamVisibility: visibility })).toEqual(
        new Set([streamGroup("stream_1"), ...OPEN_AUDIENCE[visibility]])
      )
    })
  }

  it("keeps a private thread's count to its own room and its root's room", () => {
    expect(
      count({ streamId: "stream_t", rootStreamId: "stream_root", streamVisibility: Visibilities.PRIVATE })
    ).toEqual(new Set([streamGroup("stream_t"), streamGroup("stream_root")]))
  })

  it("fans a public channel's thread count to its room, its root's room and browsers", () => {
    expect(count({ streamId: "stream_t", rootStreamId: "stream_root", streamVisibility: Visibilities.PUBLIC })).toEqual(
      new Set([streamGroup("stream_t"), streamGroup("stream_root"), BROWSE_GROUP])
    )
  })
})

describe("resolveDeliveryGroups — call lifecycle (roadmap 1.4)", () => {
  for (const eventType of ["stream:call_started", "stream:call_ended"] as const) {
    it(`should fan ${eventType} to the stream room, browsers and each member when the channel is public`, () => {
      const groups = resolveDeliveryGroups(
        event(eventType, {
          workspaceId: "ws_1",
          streamId: "stream_pub",
          callId: "call_1",
          streamVisibility: Visibilities.PUBLIC,
          memberUserIds: ["usr_a", "usr_b"],
          event: { id: "evt_1" },
        })
      )
      expect(groups).toEqual([streamGroup("stream_pub"), BROWSE_GROUP, userGroup("usr_a"), userGroup("usr_b")])
    })

    it(`should fan ${eventType} to the stream room, the whole workspace and each member when the channel is guest_public`, () => {
      const groups = resolveDeliveryGroups(
        event(eventType, {
          workspaceId: "ws_1",
          streamId: "stream_open",
          callId: "call_1",
          streamVisibility: Visibilities.GUEST_PUBLIC,
          memberUserIds: ["usr_a", "usr_b"],
          event: { id: "evt_1" },
        })
      )
      expect(groups).toEqual([streamGroup("stream_open"), WORKSPACE_GROUP, userGroup("usr_a"), userGroup("usr_b")])
    })

    it(`fans ${eventType} on a PRIVATE/DM stream to the stream room AND each member's user room, never workspace-wide`, () => {
      const groups = resolveDeliveryGroups(
        event(eventType, {
          workspaceId: "ws_1",
          streamId: "stream_dm",
          callId: "call_1",
          streamVisibility: Visibilities.PRIVATE,
          memberUserIds: ["usr_a", "usr_b"],
          event: { id: "evt_1" },
        })
      )
      expect(new Set(groups)).toEqual(new Set([streamGroup("stream_dm"), userGroup("usr_a"), userGroup("usr_b")]))
      // A private stream name/call must never leak to the whole workspace.
      expect(groups).not.toContain(WORKSPACE_GROUP)
    })
  }

  it("routes call:participants_changed to the stream room only (no dot fan-out, no timeline)", () => {
    const groups = resolveDeliveryGroups(
      event("call:participants_changed", {
        workspaceId: "ws_1",
        streamId: "stream_dm",
        callId: "call_1",
        participantCount: 2,
        participantUserIds: ["usr_a", "usr_b"],
      })
    )
    expect(groups).toEqual([streamGroup("stream_dm")])
    expect(groups).not.toContain(WORKSPACE_GROUP)
  })
})

describe("permissionGroupsForRole", () => {
  it("grants the members:write, admin and browse delivery groups to admins and owners", () => {
    expect(permissionGroupsForRole("admin")).toEqual([MEMBERS_WRITE_GROUP, WORKSPACE_ADMIN_GROUP, BROWSE_GROUP])
    expect(permissionGroupsForRole("owner")).toEqual([MEMBERS_WRITE_GROUP, WORKSPACE_ADMIN_GROUP, BROWSE_GROUP])
  })

  it("grants only the browse delivery group to plain members", () => {
    expect(permissionGroupsForRole("member")).toEqual([BROWSE_GROUP])
  })

  it("grants no permission delivery groups to guests", () => {
    expect(permissionGroupsForRole("guest")).toEqual([])
  })
})

describe("resolveDeliveryGroups — stream connections", () => {
  const payload = {
    workspaceId: "ws_1",
    streamId: "stream_1",
    adminMemberUserIds: ["usr_admin_a", "usr_admin_b"],
    connection: { id: "sconn_1" },
  }

  it("should reach every admin when the channel is public", () => {
    const groups = resolveDeliveryGroups(
      event("stream_connection:updated", { ...payload, streamVisibility: Visibilities.PUBLIC })
    )
    expect(groups).toEqual([WORKSPACE_ADMIN_GROUP])
  })

  it("should reach every admin when the channel is guest_public", () => {
    const groups = resolveDeliveryGroups(
      event("stream_connection:updated", { ...payload, streamVisibility: Visibilities.GUEST_PUBLIC })
    )
    expect(groups).toEqual([WORKSPACE_ADMIN_GROUP])
  })

  it("should reach only the admins in the channel when it is private", () => {
    const groups = resolveDeliveryGroups(
      event("stream_connection:updated", { ...payload, streamVisibility: Visibilities.PRIVATE })
    )
    expect(groups).toEqual([userGroup("usr_admin_a"), userGroup("usr_admin_b")])
  })
})

describe("resolveDeliveryGroups — stream archive lifecycle", () => {
  it("routes stream:archived to the root room and every descendant thread room", () => {
    const groups = resolveDeliveryGroups(
      event("stream:archived", {
        workspaceId: "ws_1",
        streamId: "stream_root",
        stream: { id: "stream_root" },
        threadStreamIds: ["stream_thread_a", "stream_thread_b"],
      })
    )
    expect(groups).toEqual([streamGroup("stream_root"), streamGroup("stream_thread_a"), streamGroup("stream_thread_b")])
  })

  it("routes stream:unarchived to the root room and every descendant thread room", () => {
    const groups = resolveDeliveryGroups(
      event("stream:unarchived", {
        workspaceId: "ws_1",
        streamId: "stream_root",
        stream: { id: "stream_root" },
        threadStreamIds: ["stream_thread_a"],
      })
    )
    expect(groups).toEqual([streamGroup("stream_root"), streamGroup("stream_thread_a")])
  })

  it("routes to the root room only when there are no descendant threads", () => {
    const groups = resolveDeliveryGroups(
      event("stream:archived", { workspaceId: "ws_1", streamId: "stream_root", stream: { id: "stream_root" } })
    )
    expect(groups).toEqual([streamGroup("stream_root")])
  })

  it("does not duplicate the root room when a thread id equals the root id (defensive)", () => {
    const groups = resolveDeliveryGroups(
      event("stream:archived", {
        workspaceId: "ws_1",
        streamId: "stream_root",
        stream: { id: "stream_root" },
        threadStreamIds: ["stream_root"],
      })
    )
    expect(groups).toEqual([streamGroup("stream_root")])
  })
})

describe("resolveDeliveryGroups — activity:read", () => {
  it("routes to the target user's room only, like activity:created", () => {
    const groups = resolveDeliveryGroups(
      event("activity:read", {
        workspaceId: "ws_1",
        targetUserId: "usr_alice",
        activityIds: ["act_1"],
        streamIds: ["stream_1"],
      })
    )
    expect(groups).toEqual([userGroup("usr_alice")])
  })
})

describe("resolveDeliveryGroups — memo:updated", () => {
  // The event carries a memo's card content to the streams that cite it, and
  // the server decided per room which of those may see it. Routing is driven by
  // the STREAM_SCOPED_EVENTS list, not by the payload's shape, so an event whose
  // type is missing from that list falls through to the whole-workspace group —
  // handing the content to every member regardless of stream access, and
  // undoing the per-room gate at the point of delivery. The outbox-row tests
  // cannot see this: the rows are correct either way.
  it("delivers only to the citing stream, never the whole workspace", () => {
    const groups = resolveDeliveryGroups(
      event("memo:updated", {
        workspaceId: "ws_1",
        streamId: "stream_citing",
        memoId: "memo_1",
        summary: {
          memoId: "memo_1",
          title: "Launch in June",
          knowledgeType: "decision",
          memoType: "conversation",
          tags: [],
          updatedAt: "2026-07-31T10:00:00.000Z",
        },
      })
    )

    expect(groups).toEqual([streamGroup("stream_citing")])
    expect(groups).not.toContain(WORKSPACE_GROUP)
  })
})

describe("resolveDeliveryGroups — memo:created", () => {
  // Same blindness as memo:updated above, one event earlier: this one announces
  // that a memo exists at all, and every payload is copied into `sync_log` and
  // replayed on catch-up for weeks — so a workspace group here is a standing
  // record of every capture, readable by members with no access to the stream
  // it came from. The outbox row is identical either way.
  it("delivers only to the memo's source stream, never the whole workspace", () => {
    const groups = resolveDeliveryGroups(
      event("memo:created", { workspaceId: "ws_1", streamId: "stream_source", memoId: "memo_1" })
    )

    expect(groups).toEqual([streamGroup("stream_source")])
    expect(groups).not.toContain(WORKSPACE_GROUP)
  })

  // save_memo can file a `user`-scoped memo from a shared stream. Its owner is
  // the only one who will ever see it, so the room must not even learn it exists.
  it("delivers a user-scoped memo to its owner instead of the source stream", () => {
    const groups = resolveDeliveryGroups(
      event("memo:created", {
        workspaceId: "ws_1",
        streamId: "stream_source",
        memoId: "memo_1",
        scopeUserId: "usr_owner",
      })
    )

    expect(groups).toEqual([userGroup("usr_owner")])
  })

  // Rollout window: a replica still on the old code writes the old payload —
  // no streamId, whole memo inline. Dropping it keeps that content out of the
  // log; routing it by shape would file it under `stream:undefined`.
  it("drops a pre-cutover payload instead of routing it anywhere", () => {
    const groups = resolveDeliveryGroups(
      event("memo:created", {
        workspaceId: "ws_1",
        memoId: "memo_1",
        memo: { id: "memo_1", title: "Launch in June", abstract: "…" },
      })
    )

    expect(groups).toEqual([])
  })
})
