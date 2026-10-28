import { PluginKey } from "@tiptap/pm/state"
import { MentionNode } from "@threahq/prosemirror/schema"
import { createTriggerExtension, type TriggerExtensionOptions } from "./create-trigger-extension"
import type { Mentionable } from "./types"

export const MentionPluginKey = new PluginKey("mention")

export interface MentionNodeAttrs {
  id: string
  slug: string
  mentionType: "user" | "persona" | "bot" | "broadcast" | "me"
}

export type MentionOptions = TriggerExtensionOptions<Mentionable>

const mentionTypeClasses: Record<string, string> = {
  user: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200",
  persona: "bg-primary/10 text-primary",
  bot: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200",
  broadcast: "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-200",
  me: "bg-blue-100 text-primary dark:bg-blue-900/50 dark:text-primary",
}

/**
 * TipTap extension for @mentions.
 * Creates an inline node that renders as a styled mention chip.
 */
export const MentionExtension = createTriggerExtension<Mentionable, MentionNodeAttrs>({
  node: MentionNode,
  pluginKey: MentionPluginKey,
  char: "@",
  getClassName: (attrs) => mentionTypeClasses[attrs.mentionType] ?? mentionTypeClasses.user,
  mapPropsToAttrs: (m) => ({
    id: m.id,
    slug: m.slug,
    mentionType: m.isCurrentUser ? "me" : m.type,
  }),
})
