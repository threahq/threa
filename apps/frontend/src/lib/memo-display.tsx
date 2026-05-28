import { BookOpen, BookmarkIcon, Compass, Lightbulb, ListChecks } from "lucide-react"

/**
 * Display config for a memo's `knowledgeType`. Shared by the memory explorer
 * page and the inline memo-embed card so a new knowledge type only needs an
 * entry here to render consistently in both places.
 *
 * `className` styles the explorer's badge pill; `accent` is the explorer's
 * per-type left border. The embed card uses only `icon` + `label` (its accent
 * is the app's gold thread-line, not the per-type color).
 */
export const KNOWLEDGE_TYPE_CONFIG: Record<
  string,
  { icon: typeof BookOpen; label: string; className: string; accent: string }
> = {
  decision: {
    icon: Compass,
    label: "Decision",
    className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-800",
    accent: "border-l-blue-500",
  },
  learning: {
    icon: Lightbulb,
    label: "Learning",
    className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
    accent: "border-l-emerald-500",
  },
  procedure: {
    icon: ListChecks,
    label: "Procedure",
    className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800",
    accent: "border-l-amber-500",
  },
  context: {
    icon: BookOpen,
    label: "Context",
    className: "bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-200 dark:border-violet-800",
    accent: "border-l-violet-500",
  },
  reference: {
    icon: BookmarkIcon,
    label: "Reference",
    className: "bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-200 dark:border-slate-800",
    accent: "border-l-slate-500",
  },
}

export function getKnowledgeConfig(type: string) {
  return KNOWLEDGE_TYPE_CONFIG[type] ?? KNOWLEDGE_TYPE_CONFIG.context
}

/** Capitalize a memo enum value (`memoType` / `knowledgeType`) for display. */
export function memoLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
