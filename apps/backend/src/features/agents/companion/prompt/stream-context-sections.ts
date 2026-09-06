import { StreamTypes } from "@threahq/types"
import type { StreamContext } from "../../context-builder"

export function buildScratchpadPrompt(context: StreamContext, workspaceResearchEnabled: boolean): string {
  let section = "\n\n## Context\n\n"
  section += "You are in a personal scratchpad"

  if (context.streamInfo.name) {
    section += ` called "${context.streamInfo.name}"`
  }
  section += ". This is a private space for notes and thinking."

  if (context.streamInfo.description) {
    section += `\n\nDescription: ${context.streamInfo.description}`
  }

  if (workspaceResearchEnabled) {
    section += `\n\nYou can use the \`workspace_research\` tool to retrieve relevant knowledge from past conversations, scratchpads, and memos. Reference retrieved knowledge naturally without citing sources unless asked.`
  }

  return section
}

export function buildChannelPrompt(context: StreamContext): string {
  let section = "\n\n## Context\n\n"
  section += "You are in a channel"

  if (context.streamInfo.name) {
    section += ` called "${context.streamInfo.name}"`
  }
  if (context.streamInfo.slug) {
    section += ` (#${context.streamInfo.slug})`
  }
  section += ". This is a collaborative team space."

  if (context.streamInfo.description) {
    section += `\n\nChannel description: ${context.streamInfo.description}`
  }

  if (context.participants && context.participants.length > 0) {
    section += "\n\nChannel members:\n"
    for (const p of context.participants) {
      section += `- ${p.name}\n`
    }
  }

  return section
}

export function buildThreadPrompt(context: StreamContext): string {
  let section = "\n\n## Context\n\n"
  section += "You are in a thread"

  if (context.streamInfo.name) {
    section += ` called "${context.streamInfo.name}"`
  }
  section += ". This is a focused thread branching from a parent conversation."

  if (context.streamInfo.description) {
    section += `\n\nThread description: ${context.streamInfo.description}`
  }

  if (context.threadContext && context.threadContext.path.length > 1) {
    section += `\n\nThread hierarchy (${context.threadContext.depth} levels deep):\n`

    for (let i = 0; i < context.threadContext.path.length; i++) {
      const entry = context.threadContext.path[i]
      const indent = "  ".repeat(i)
      const name = entry.displayName ?? "Untitled"

      if (i === 0) {
        section += `${indent}[Root] ${name}\n`
      } else if (i === context.threadContext.path.length - 1) {
        section += `${indent}[Current] ${name}\n`
      } else {
        section += `${indent}└─ ${name}\n`
      }

      if (entry.anchorMessage) {
        section += `${indent}   Spawned from: "${entry.anchorMessage.content}" (by ${entry.anchorMessage.authorName})\n`
      }
    }
  }

  return section
}

export function buildDmPrompt(context: StreamContext): string {
  let section = "\n\n## Context\n\n"
  section += "You are in a direct message conversation"

  if (context.participants && context.participants.length > 0) {
    const names = context.participants.map((p) => p.name).join(" and ")
    section += ` between ${names}`
  }
  section += "."

  if (context.streamInfo.description) {
    section += `\n\nDescription: ${context.streamInfo.description}`
  }

  return section
}

export function buildPromptSectionForStreamType(context: StreamContext, workspaceResearchEnabled: boolean): string {
  let section: string
  switch (context.streamType) {
    case StreamTypes.SCRATCHPAD:
      section = buildScratchpadPrompt(context, workspaceResearchEnabled)
      break
    case StreamTypes.CHANNEL:
      section = buildChannelPrompt(context)
      break
    case StreamTypes.THREAD:
      section = buildThreadPrompt(context)
      break
    case StreamTypes.DM:
      section = buildDmPrompt(context)
      break
    default:
      section = buildScratchpadPrompt(context, workspaceResearchEnabled)
  }

  // Surface the active stream id so the agent can build `shared-message:` /
  // `quote:` pointer URLs back at messages in this conversation. Per-message
  // tags carry msg + author ids; stream id is constant across the window.
  section += `\n\nStream id: \`${context.streamInfo.id}\``

  return section
}
