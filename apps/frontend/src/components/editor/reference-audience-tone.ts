import { Eye, Lock } from "lucide-react"

export const AUDIENCE_TONE = {
  unreachable: {
    icon: Lock,
    text: "text-amber-700 dark:text-amber-400",
    fill: "bg-amber-600 dark:bg-amber-400",
    surface: "bg-amber-500/10",
  },
  reveal: {
    icon: Eye,
    text: "text-sky-600 dark:text-sky-400",
    fill: "bg-sky-600 dark:bg-sky-400",
    surface: "border-sky-600/50 dark:border-sky-400/50",
  },
} as const
