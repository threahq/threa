/**
 * Consolidated step display configuration (INV-29, INV-43).
 * Single source of truth for all step type display properties.
 * Both inline activity indicators and trace dialog use this config.
 */
import type { AgentStepType } from "@threa/types"
import {
  Inbox,
  Lightbulb,
  RotateCcw,
  Search,
  FileText,
  Building2,
  Github,
  CircleDot,
  MessageSquare,
  Wrench,
  AlertTriangle,
  Hourglass,
  type LucideIcon,
} from "lucide-react"

export interface StepDisplayConfig {
  /** Short label for trace dialog headers (e.g., "Context", "Thinking") */
  label: string
  /** Progressive tense for inline activity indicators (e.g., "Reading messages...", "Thinking...") */
  inlineLabel: string
  /** Icon component for the step */
  icon: LucideIcon
  /** HSL hue for step coloring */
  hue: number
  /** HSL saturation for step coloring */
  saturation: number
  /** HSL lightness for step coloring */
  lightness: number
}

export const STEP_DISPLAY_CONFIG: Record<AgentStepType, StepDisplayConfig> = {
  context_received: {
    label: "Context",
    inlineLabel: "Reading messages...",
    icon: Inbox,
    hue: 220,
    saturation: 70,
    lightness: 55,
  },
  thinking: {
    label: "Thinking",
    inlineLabel: "Thinking...",
    icon: Lightbulb,
    hue: 45,
    saturation: 93,
    lightness: 47,
  },
  reconsidering: {
    label: "Reconsidering",
    inlineLabel: "Reconsidering...",
    icon: RotateCcw,
    hue: 280,
    saturation: 70,
    lightness: 55,
  },
  web_search: {
    label: "Web Search",
    inlineLabel: "Searching the web...",
    icon: Search,
    hue: 200,
    saturation: 70,
    lightness: 50,
  },
  visit_page: {
    label: "Reading Page",
    inlineLabel: "Reading page...",
    icon: FileText,
    hue: 200,
    saturation: 70,
    lightness: 50,
  },
  workspace_search: {
    label: "Workspace Search",
    inlineLabel: "Searching workspace...",
    icon: Building2,
    hue: 270,
    saturation: 60,
    lightness: 50,
  },
  github_access: {
    label: "GitHub",
    inlineLabel: "Reading GitHub...",
    icon: Github,
    hue: 210,
    saturation: 10,
    lightness: 25,
  },
  linear_access: {
    label: "Linear",
    inlineLabel: "Reading Linear...",
    icon: CircleDot,
    hue: 238,
    saturation: 56,
    lightness: 60,
  },
  message_sent: {
    label: "Response",
    inlineLabel: "Sending response...",
    icon: MessageSquare,
    hue: 142,
    saturation: 76,
    lightness: 36,
  },
  message_edited: {
    label: "Response Updated",
    inlineLabel: "Updating response...",
    icon: MessageSquare,
    hue: 142,
    saturation: 76,
    lightness: 36,
  },
  response: {
    label: "Response",
    inlineLabel: "Composing response...",
    icon: MessageSquare,
    hue: 142,
    saturation: 76,
    lightness: 36,
  },
  tool_call: {
    label: "Tool Call",
    inlineLabel: "Using tools...",
    icon: Wrench,
    hue: 200,
    saturation: 70,
    lightness: 50,
  },
  tool_error: {
    label: "Error",
    inlineLabel: "Encountered an error...",
    icon: AlertTriangle,
    hue: 0,
    saturation: 72,
    lightness: 51,
  },
  rate_limited: {
    label: "Rate Limited",
    inlineLabel: "Rate limited, waiting...",
    icon: Hourglass,
    hue: 38,
    saturation: 92,
    lightness: 50,
  },
  rate_limit_retry: {
    label: "Retrying",
    inlineLabel: "Retrying...",
    icon: RotateCcw,
    hue: 38,
    saturation: 92,
    lightness: 50,
  },
}

/**
 * Get the inline activity label for a step type.
 * Returns "Working..." for null/unknown step types.
 */
export function getStepInlineLabel(stepType: AgentStepType | null): string {
  if (!stepType) return "Working..."
  return STEP_DISPLAY_CONFIG[stepType]?.inlineLabel ?? "Working..."
}
