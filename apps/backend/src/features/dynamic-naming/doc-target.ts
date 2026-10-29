import type { Pool, PoolClient } from "pg"
import { StreamTypes, TitleSources } from "@threahq/types"
import { withClient } from "../../db"
import { DocRepository } from "../docs"
import type { Querier } from "../../db"
import { StreamRepository, type Stream } from "../streams"
import { DYNAMIC_NAMING_MAX_DOC_CONTEXT_CHARS, DYNAMIC_NAMING_MAX_EXISTING_TITLES } from "./config"
import { applyStreamDisplayNameRename, type StreamBackedTargetSnapshot } from "./stream-target"
import type {
  DynamicNamingTargetAdapter,
  DynamicNamingTargetContext,
  DynamicNamingTargetLockParams,
  DynamicNamingTargetSnapshot,
} from "./types"

function isDocTargetSnapshot(target: DynamicNamingTargetSnapshot): target is StreamBackedTargetSnapshot {
  return target.targetKind === "doc" && "stream" in target
}

/** A doc the namer may title: a live, locally owned doc whose title is absent or was generated. */
export function isNameableDocStream(stream: Stream | null): stream is Stream {
  if (!stream || stream.type !== StreamTypes.DOC || stream.archivedAt || stream.originWorkspaceId) return false
  const source = stream.displayNameSource ?? null
  return source === null || source === TitleSources.GENERATED
}

/** A doc's "message count" for the naming checkpoints: blocks that hold text. */
export async function countDocBlocks(db: Querier, workspaceId: string, docId: string): Promise<number> {
  const sections = await DocRepository.listSections(db, workspaceId, docId)
  return sections.filter((section) => section.markdown.trim().length > 0).length
}

/** A doc's title is its stream's display name; the body stands in for the conversation. */
export class DynamicNamingDocTarget implements DynamicNamingTargetAdapter {
  constructor(private readonly pool: Pool) {}

  /** Whoever may write the doc may have it titled; a doc takes Yjs writes, never messages. */
  readonly authorityTypeReadOnly = "none"

  async resolveAuthorityStreamId(client: PoolClient, params: DynamicNamingTargetLockParams): Promise<string | null> {
    if (params.targetKind !== "doc") return null
    const doc = await StreamRepository.findById(client, params.workspaceId, params.targetId)
    return doc?.type === StreamTypes.DOC ? doc.id : null
  }

  async lockAndValidate(
    client: PoolClient,
    params: DynamicNamingTargetLockParams
  ): Promise<StreamBackedTargetSnapshot | null> {
    if (params.targetKind !== "doc") return null
    const stream = await StreamRepository.findByIdForUpdateBlocking(client, params.workspaceId, params.targetId)
    if (!isNameableDocStream(stream)) return null

    const source = stream.displayNameSource ?? null
    const titleRevision = stream.displayNameRevision ?? 0
    if (params.expectedTitleRevision !== undefined && params.expectedTitleRevision !== titleRevision) return null

    const head = await DocRepository.findHead(client, params.workspaceId, stream.id)
    return {
      workspaceId: stream.workspaceId,
      targetKind: "doc",
      targetId: stream.id,
      messageCount: await countDocBlocks(client, params.workspaceId, stream.id),
      latestMessageAt: head?.updatedAt ?? null,
      title: stream.displayName,
      titleSource: source,
      titleRevision,
      stream,
    }
  }

  async loadContext(target: DynamicNamingTargetSnapshot): Promise<DynamicNamingTargetContext | null> {
    if (!isDocTargetSnapshot(target)) return null
    const hostId = target.stream.parentStreamId
    return withClient(this.pool, async (client) => {
      const head = await DocRepository.findHead(client, target.workspaceId, target.targetId)
      if (!head || head.bodyMarkdown.trim().length === 0) return null
      const siblings = hostId
        ? await StreamRepository.list(client, target.workspaceId, { parentStreamId: hostId, types: [StreamTypes.DOC] })
        : []
      const existingTitles = siblings
        .filter((stream) => stream.id !== target.targetId && stream.displayName)
        .slice(0, DYNAMIC_NAMING_MAX_EXISTING_TITLES)
        .map((stream) => stream.displayName!)
      return {
        context: head.bodyMarkdown.slice(0, DYNAMIC_NAMING_MAX_DOC_CONTEXT_CHARS),
        currentTitle: target.title,
        existingTitles,
        sharedRootStreamId: null,
      }
    })
  }

  async applyRename(client: PoolClient, target: DynamicNamingTargetSnapshot, title: string): Promise<number | null> {
    if (!isDocTargetSnapshot(target)) return null
    return applyStreamDisplayNameRename(client, target, title)
  }
}
