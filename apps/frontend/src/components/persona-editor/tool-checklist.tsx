import { useMemo } from "react"
import {
  AGENT_TOOL_NAMES,
  TOOL_CATEGORIES_BY_NAME,
  TOOL_PRIVACY_CATEGORIES,
  TOOL_PRIVACY_CATEGORY_LABELS,
  type AgentToolName,
  type ToolPrivacyCategory,
} from "@threa/types"
import { Checkbox } from "@/components/ui/checkbox"

/**
 * Tools grouped by their primary privacy category (the first of the tool's
 * categories) so a 30-tool list reads as a handful of scannable sections. Built
 * once — the catalog is static.
 */
const TOOLS_BY_CATEGORY: { category: ToolPrivacyCategory; tools: AgentToolName[] }[] = TOOL_PRIVACY_CATEGORIES.map(
  (category) => ({
    category,
    tools: AGENT_TOOL_NAMES.filter((tool) => TOOL_CATEGORIES_BY_NAME[tool][0] === category),
  })
).filter((group) => group.tools.length > 0)

function humanizeTool(tool: AgentToolName): string {
  const words = tool.split("_")
  return words
    .map((word, index) => {
      if (word === "github") return "GitHub"
      if (word === "linear") return "Linear"
      if (word === "url") return "URL"
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
    })
    .join(" ")
}

interface ToolChecklistProps {
  value: AgentToolName[]
  defaults: readonly AgentToolName[]
  onChange: (next: AgentToolName[]) => void
  disabled?: boolean
}

/**
 * Per-tool enable checkboxes grouped by privacy category. A dot marks a tool
 * whose enabled state diverges from the built-in default so the admin can see
 * what they changed at a glance.
 */
export function ToolChecklist({ value, defaults, onChange, disabled }: ToolChecklistProps) {
  const enabled = useMemo(() => new Set(value), [value])
  const defaultEnabled = useMemo(() => new Set(defaults), [defaults])

  const toggle = (tool: AgentToolName, checked: boolean) => {
    if (checked) onChange([...value, tool])
    else onChange(value.filter((t) => t !== tool))
  }

  return (
    <div className="space-y-4">
      {TOOLS_BY_CATEGORY.map((group) => (
        <div key={group.category} className="space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {TOOL_PRIVACY_CATEGORY_LABELS[group.category]}
          </p>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {group.tools.map((tool) => {
              const isEnabled = enabled.has(tool)
              const diverges = isEnabled !== defaultEnabled.has(tool)
              return (
                <label key={tool} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
                  <Checkbox
                    checked={isEnabled}
                    disabled={disabled}
                    onCheckedChange={(checked) => toggle(tool, checked === true)}
                    aria-label={humanizeTool(tool)}
                  />
                  <span className="truncate">{humanizeTool(tool)}</span>
                  {diverges && (
                    <span
                      aria-hidden
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500"
                      title="Changed from default"
                    />
                  )}
                </label>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
