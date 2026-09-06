import { Bot, Brain, MessagesSquare, MoreHorizontal, Paperclip, type LucideIcon } from "lucide-react"
import type { AIUsageCategory } from "@threahq/types"

export const categoryMeta: Record<AIUsageCategory, { label: string; icon: LucideIcon }> = {
  memory: { label: "Memory (GAM)", icon: Brain },
  conversation: { label: "Conversation tracking", icon: MessagesSquare },
  agents: { label: "Agents & personas", icon: Bot },
  attachments: { label: "Attachments", icon: Paperclip },
  other: { label: "Other", icon: MoreHorizontal },
}

export const categoryColor: Record<AIUsageCategory, string> = {
  memory: "hsl(var(--chart-1))",
  conversation: "hsl(var(--chart-2))",
  agents: "hsl(var(--chart-3))",
  attachments: "hsl(var(--chart-4))",
  other: "hsl(var(--chart-5))",
}
