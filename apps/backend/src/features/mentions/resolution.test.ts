import { describe, expect, it } from "bun:test"
import type { JSONContent, MentionActorType } from "@threa/types"
import { applyMentionResolution, type MentionResolutionMaps } from "./index"

const mention = (id: string, slug: string, mentionType: string): JSONContent => ({
  type: "mention",
  attrs: { id, slug, mentionType },
})

const channelLink = (id: string, slug: string): JSONContent => ({
  type: "channelLink",
  attrs: { id, slug },
})

const doc = (...content: JSONContent[]): JSONContent => ({
  type: "doc",
  content: [{ type: "paragraph", content }],
})

const maps = (overrides?: {
  mention?: Array<[string, { id: string; actorType: MentionActorType }]>
  channel?: Array<[string, string]>
}): MentionResolutionMaps => ({
  mentionSlugToActor: new Map(overrides?.mention ?? []),
  channelSlugToStreamId: new Map(overrides?.channel ?? []),
})

describe("applyMentionResolution", () => {
  it("rewrites an unresolved mention slug to its actor id and corrects mentionType", () => {
    const result = applyMentionResolution(
      doc(mention("ariadne", "ariadne", "user")),
      maps({ mention: [["ariadne", { id: "persona_system_ariadne", actorType: "persona" }]] })
    )

    expect(result).toEqual({
      changed: true,
      contentJson: doc({
        type: "mention",
        attrs: { id: "persona_system_ariadne", slug: "ariadne", mentionType: "persona" },
      }),
    })
  })

  it("matches slugs case-insensitively via the lowercased map key", () => {
    const result = applyMentionResolution(
      doc(mention("Ariadne", "Ariadne", "persona")),
      maps({ mention: [["ariadne", { id: "persona_system_ariadne", actorType: "persona" }]] })
    )

    expect(result).toEqual({
      changed: true,
      contentJson: doc({
        type: "mention",
        attrs: { id: "persona_system_ariadne", slug: "Ariadne", mentionType: "persona" },
      }),
    })
  })

  it("applies user>persona>bot precedence as encoded in the prebuilt map", () => {
    // buildMentionResolutionMaps writes the first match by precedence; the pure
    // step trusts whatever the map says. A "support" slug that resolved to a user
    // must rewrite to the user id, not a bot id, even though a bot also exists.
    const result = applyMentionResolution(
      doc(mention("support", "support", "bot")),
      maps({ mention: [["support", { id: "usr_support_lead", actorType: "user" }]] })
    )

    expect(result).toEqual({
      changed: true,
      contentJson: doc({
        type: "mention",
        attrs: { id: "usr_support_lead", slug: "support", mentionType: "user" },
      }),
    })
  })

  it("resolves the here broadcast slug to its sentinel id and broadcast mentionType", () => {
    const result = applyMentionResolution(doc(mention("here", "here", "user")), maps())

    expect(result).toEqual({
      changed: true,
      contentJson: doc({
        type: "mention",
        attrs: { id: "broadcast:here", slug: "here", mentionType: "broadcast" },
      }),
    })
  })

  it("resolves the channel broadcast slug to its sentinel id and broadcast mentionType", () => {
    const result = applyMentionResolution(doc(mention("channel", "channel", "user")), maps())

    expect(result).toEqual({
      changed: true,
      contentJson: doc({
        type: "mention",
        attrs: { id: "broadcast:channel", slug: "channel", mentionType: "broadcast" },
      }),
    })
  })

  it("resolves an unresolved channelLink slug to its stream id", () => {
    const result = applyMentionResolution(
      doc(channelLink("general", "general")),
      maps({ channel: [["general", "stream_general"]] })
    )

    expect(result).toEqual({
      changed: true,
      contentJson: doc({ type: "channelLink", attrs: { id: "stream_general", slug: "general" } }),
    })
  })

  it("resolves mentions and channel links together in one pass", () => {
    const result = applyMentionResolution(
      doc(mention("alice", "alice", "user"), channelLink("general", "general"), mention("here", "here", "user")),
      maps({
        mention: [["alice", { id: "usr_alice", actorType: "user" }]],
        channel: [["general", "stream_general"]],
      })
    )

    expect(result).toEqual({
      changed: true,
      contentJson: doc(
        { type: "mention", attrs: { id: "usr_alice", slug: "alice", mentionType: "user" } },
        { type: "channelLink", attrs: { id: "stream_general", slug: "general" } },
        { type: "mention", attrs: { id: "broadcast:here", slug: "here", mentionType: "broadcast" } }
      ),
    })
  })

  it("no-ops on already-resolved mention and channelLink ids", () => {
    const input = doc(
      mention("usr_alice", "alice", "user"),
      mention("broadcast:here", "here", "broadcast"),
      channelLink("stream_general", "general")
    )

    const result = applyMentionResolution(
      input,
      maps({
        mention: [["alice", { id: "usr_alice", actorType: "user" }]],
        channel: [["general", "stream_general"]],
      })
    )

    expect(result.changed).toBe(false)
    expect(result.contentJson).toBe(input)
  })

  it("leaves an unresolvable slug untouched and reports no change", () => {
    const input = doc(mention("ghost", "ghost", "user"), channelLink("missing", "missing"))

    const result = applyMentionResolution(input, maps())

    expect(result.changed).toBe(false)
    expect(result.contentJson).toBe(input)
  })

  it("rewrites only the resolvable nodes when a document mixes resolvable and unresolvable refs", () => {
    const result = applyMentionResolution(
      doc(mention("alice", "alice", "user"), mention("ghost", "ghost", "user")),
      maps({ mention: [["alice", { id: "usr_alice", actorType: "user" }]] })
    )

    expect(result).toEqual({
      changed: true,
      contentJson: doc(
        { type: "mention", attrs: { id: "usr_alice", slug: "alice", mentionType: "user" } },
        { type: "mention", attrs: { id: "ghost", slug: "ghost", mentionType: "user" } }
      ),
    })
  })

  it("corrects the mentionType of a resolved id whose label disagrees with its actor kind", () => {
    // The id already carries the right actor (bot_), but a stale mentionType
    // ("user") must be normalized to match the map's actorType.
    const result = applyMentionResolution(
      doc(mention("bot_helper", "helper", "user")),
      maps({ mention: [["helper", { id: "bot_helper", actorType: "bot" }]] })
    )

    expect(result).toEqual({
      changed: true,
      contentJson: doc({
        type: "mention",
        attrs: { id: "bot_helper", slug: "helper", mentionType: "bot" },
      }),
    })
  })
})

describe("applyMentionResolution inside an agent block", () => {
  it("resolves a mention nested in an agentBlock and leaves the node and its attribution intact", () => {
    const block = (mentionNode: JSONContent): JSONContent => ({
      type: "doc",
      content: [
        {
          type: "agentBlock",
          attrs: { authorId: "persona_01ARIADNE", authorName: "Ariadne" },
          content: [{ type: "paragraph", content: [mentionNode] }],
        },
      ],
    })

    const result = applyMentionResolution(
      block(mention("alice", "alice", "user")),
      maps({ mention: [["alice", { id: "usr_01ALICE", actorType: "user" }]] })
    )

    expect(result).toEqual({
      changed: true,
      contentJson: block({ type: "mention", attrs: { id: "usr_01ALICE", slug: "alice", mentionType: "user" } }),
    })
  })
})
