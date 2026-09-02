/**
 * Shared seeding for the subagent suites: a workspace, its users, a persona to
 * delegate to, and channels of either visibility — the four things every
 * subagent test needs before it can open a run.
 */

import type { Pool } from "pg"
import { withTransaction } from "../../src/db"
import { userId, workspaceId as newWorkspaceId } from "../../src/lib/id"
import { WorkspaceRepository } from "../../src/features/workspaces"
import { StreamService } from "../../src/features/streams"
import { PersonaRepository, type Persona } from "../../src/features/agents"
import { addTestMember } from "./setup"
import { Visibilities, type Stream } from "@threa/types"

export interface SubagentTestContext {
  pool: Pool
  streamService: StreamService
  workspaceId: string
  owner: string
  member: string
  outsider: string
  persona: Persona
  createChannel(params: { slug: string; visibility?: "public" | "private"; memberIds?: string[] }): Promise<Stream>
}

export async function createSubagentTestContext(pool: Pool, label: string): Promise<SubagentTestContext> {
  const streamService = new StreamService(pool)
  const workspaceId = newWorkspaceId()

  const { owner, member, outsider, persona } = await withTransaction(pool, async (client) => {
    const owner = (await addTestMember(client, workspaceId, userId())).id
    const member = (await addTestMember(client, workspaceId, userId())).id
    const outsider = (await addTestMember(client, workspaceId, userId())).id
    await WorkspaceRepository.insert(client, {
      id: workspaceId,
      name: `Subagent ${label}`,
      slug: `subagent-${label}-${workspaceId.toLowerCase()}`,
      createdBy: owner,
    })
    const persona = await PersonaRepository.insertWorkspacePersona(client, {
      workspaceId,
      slug: `delegate-${workspaceId.slice(-8).toLowerCase()}`,
      config: {
        name: "Ariadne",
        description: null,
        avatarEmoji: null,
        systemPrompt: "Base system prompt",
        model: PERSONA_MODEL,
        escalationModel: null,
        temperature: null,
        maxTokens: null,
        enabledTools: [],
        tonePrompt: null,
        brevityPrompt: null,
      },
    })
    return { owner, member, outsider, persona }
  })

  return {
    pool,
    streamService,
    workspaceId,
    owner,
    member,
    outsider,
    persona,
    createChannel: ({ slug, visibility = "public", memberIds = [] }) =>
      streamService.createChannel({
        workspaceId,
        slug: `${slug}-${workspaceId.slice(-8).toLowerCase()}`,
        visibility: visibility === "public" ? Visibilities.PUBLIC : Visibilities.PRIVATE,
        createdBy: memberIds[0] ?? owner,
        memberIds,
      }),
  }
}

/** The persona's own model, so a pinned subagent model is visibly a different one. */
export const PERSONA_MODEL = "openrouter:anthropic/claude-sonnet-5"

/** A delegable model from the workspace default set (`DEFAULT_SUBAGENT_MODELS`). */
export const DELEGATED_MODEL = "openrouter:openai/gpt-5.6-terra"

export function createParams(
  ctx: SubagentTestContext,
  parentStreamId: string,
  overrides: Partial<{ model: string; title: string; brief: string; createdBy: string }> = {}
) {
  return {
    workspaceId: ctx.workspaceId,
    parentStreamId,
    parentSessionId: null,
    triggerMessageId: null,
    sourceConversationId: null,
    personaId: ctx.persona.id,
    model: overrides.model ?? DELEGATED_MODEL,
    createdBy: overrides.createdBy ?? ctx.owner,
    title: overrides.title ?? "Second opinion on the migration plan",
    brief: overrides.brief ?? "Review the plan and tell the user what it misses.",
  }
}
