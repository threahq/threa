import { describe, expect, test } from "vitest"
import { mergeConversationByTitleRevision, mergeStreamByTitleRevision } from "./title-merge"
import type { ConversationWithStaleness, Stream } from "@threa/types"

const stream = (revision: number): Stream =>
  ({
    id: "stream_1",
    displayName: `title-${revision}`,
    displayNameSource: "explicit",
    displayNameRevision: revision,
    displayNameUpdatedByUserId: "usr_1",
    sealedNameCiphertext: `cipher-${revision}`,
    sealedNameEnvelope: { revision },
    description: `description-${revision}`,
  }) as Stream

const conversation = (revision: number): ConversationWithStaleness =>
  ({
    id: "conv_1",
    topicSummary: `topic-${revision}`,
    topicSummarySource: "explicit",
    topicSummaryRevision: revision,
    topicSummaryUpdatedByUserId: "usr_1",
    summary: `summary-${revision}`,
  }) as ConversationWithStaleness

describe("revision-guarded title merges", () => {
  test.each([
    ["lower", 1],
    ["missing", undefined],
  ])("preserves every stream title field for %s revisions while merging non-title fields", (_label, revision) => {
    const cached = stream(2)
    const incoming = { ...stream(1), displayNameRevision: revision, description: "new description" }
    expect(mergeStreamByTitleRevision(cached, incoming)).toMatchObject({
      displayName: "title-2",
      displayNameSource: "explicit",
      displayNameRevision: 2,
      displayNameUpdatedByUserId: "usr_1",
      sealedNameCiphertext: "cipher-2",
      sealedNameEnvelope: { revision: 2 },
      description: "new description",
    })
  })

  test.each([2, 3])("accepts equal/newer stream title revision %s", (revision) => {
    expect(mergeStreamByTitleRevision(stream(2), stream(revision)).displayName).toBe(`title-${revision}`)
  })

  test.each([1, undefined])("guards conversation revision %s while accepting summary", (revision) => {
    const merged = mergeConversationByTitleRevision(conversation(2), {
      ...conversation(1),
      topicSummaryRevision: revision,
      summary: "new summary",
    })
    expect({ title: merged.topicSummary, revision: merged.topicSummaryRevision, summary: merged.summary }).toEqual({
      title: "topic-2",
      revision: 2,
      summary: "new summary",
    })
  })

  test.each([2, 3])("accepts equal/newer conversation title revision %s", (revision) => {
    expect(mergeConversationByTitleRevision(conversation(2), conversation(revision)).topicSummary).toBe(
      `topic-${revision}`
    )
  })
})
