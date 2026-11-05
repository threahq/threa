import { useId, useState } from "react"
import { ChevronDown } from "lucide-react"
import { StreamTypes, WORKSPACE_PERMISSION_SCOPES, type StreamType, type ToolPrivacyPolicy } from "@threahq/types"
import { usePreferencesOptional } from "@/contexts/preferences-context"
import { useOptionalSettings } from "@/contexts/settings-context"
import { settingHref } from "@/hooks/use-setting-href"
import { SettingsLink } from "@/components/workspace-settings/settings-link"
import {
  AudienceBadge,
  LANDING_TARGET_CLASS,
  SETTING_ROW_CHEVRON_CLASS,
  SettingLinkRow,
  SettingValueRowBody,
  SettingsSection,
  landingTargetProps,
} from "@/components/settings/setting-primitives"
import { SETTING_INPUT_FRAME, SETTING_NOTE_TEXT } from "@/components/settings/setting-text"
import { STREAM_SETTINGS_SECTIONS, settingAnchorId } from "@/components/settings/settings-registry"
import { MarkdownContent } from "@/components/ui/markdown-content"
import { useStreamBrief } from "@/hooks/use-stream-brief"
import { useViewerPermissions } from "@/hooks/use-workspaces"
import { hasPermission } from "@/lib/permissions"
import { cn } from "@/lib/utils"
import { useWorkspacePersonas } from "@/stores/workspace-store"
import { briefSharedWith, describeAgentContext, type AgentContextItem } from "./agent-context"

interface AgentContextSummaryProps {
  workspaceId: string
  /** The persona that replies here (resolved, never the inherit sentinel). */
  personaId: string | undefined
  e2e: boolean
  /** The stream; absent for a scratchpad that isn't created yet. */
  stream?: { id: string; type: StreamType; root?: { type: StreamType; slug?: string | null } | null }
  /** The scratchpad's tool policy; omit where the page already shows it, or the stream has none. */
  tools?: { policy: ToolPrivacyPolicy; viewerIsOwner: boolean }
  /** Rows the surrounding page already shows as controls. */
  exclude?: readonly AgentContextItem["id"][]
  /** `section` in the stream's Agent page, `panel` under the scratchpad's agent controls. */
  variant: "section" | "panel"
}

/** A read-only list of what shapes the agent's replies here, each linked to where it's edited. */
export function AgentContextSummary({
  workspaceId,
  personaId,
  e2e,
  stream,
  tools,
  exclude,
  variant,
}: AgentContextSummaryProps) {
  const headingId = useId()
  const preferences = usePreferencesOptional()?.preferences
  const isAdmin = hasPermission(useViewerPermissions(workspaceId), WORKSPACE_PERMISSION_SCOPES.WORKSPACE_ADMIN)
  const persona = useWorkspacePersonas(workspaceId).find((row) => row.id === personaId)
  const briefStreamId = stream && !e2e && !exclude?.includes("brief") ? stream.id : ""
  const brief = useStreamBrief(workspaceId, briefStreamId)

  const type = stream?.type ?? StreamTypes.SCRATCHPAD
  const isThread = type === StreamTypes.THREAD
  const instructionsApply =
    type === StreamTypes.SCRATCHPAD || (isThread && stream?.root?.type === StreamTypes.SCRATCHPAD)

  const items = describeAgentContext({
    agent: persona
      ? {
          id: persona.id,
          model: persona.model,
          instructions: persona.systemPrompt,
          personal: persona.managedBy === "user",
        }
      : null,
    e2e,
    isAdmin,
    instructions: instructionsApply ? (preferences?.scratchpadCustomPrompt ?? null) : undefined,
    brief: briefStreamId
      ? {
          content: brief.data?.content ?? null,
          loading: brief.isLoading,
          sharedWith: isThread ? briefSharedWith(stream?.root) : null,
        }
      : undefined,
    tools,
    deviceSharing: preferences?.shareDeviceWithAgents ?? true,
  }).filter((item) => !exclude?.includes(item.id))

  const settings = useOptionalSettings()
  const hrefOf = (item: AgentContextItem): string | null => {
    if (!item.link) return null
    if ("persona" in item.link) return `/w/${workspaceId}/settings/personas/${item.link.persona}`
    if (!settings) return null
    if ("setting" in item.link) return settingHref(settings.getSettingsUrl, item.link.setting)
    return stream ? settings.getStreamSettingsUrl(stream.id, "companion", item.link.streamSetting) : null
  }

  if (items.length === 0) return null

  const rows = items.map((item) => (
    <li key={item.id}>
      {item.detail ? (
        <AgentContextDetailRow item={item} href={hrefOf(item)} variant={variant} />
      ) : (
        <SettingLinkRow
          label={<ItemLabel item={item} variant={variant} />}
          description={aboutLine(item)}
          href={hrefOf(item)}
          {...(item.prose ? { preview: item.value } : { value: item.value })}
          compact={variant === "panel"}
        />
      )}
    </li>
  ))

  if (variant === "panel") {
    return (
      <section aria-labelledby={headingId} className="border-t pt-3">
        <h3 id={headingId} className="px-2 pb-1 text-xs font-medium text-muted-foreground">
          {STREAM_SETTINGS_SECTIONS["stream-agent-sees"].title}
        </h3>
        <ul>{rows}</ul>
      </section>
    )
  }
  return (
    <SettingsSection section="stream-agent-sees">
      <ul
        id={settingAnchorId("stream-agent-context")}
        data-setting="stream-agent-context"
        {...landingTargetProps}
        className={cn("divide-y divide-border overflow-hidden rounded-lg", LANDING_TARGET_CLASS)}
      >
        {rows}
      </ul>
    </SettingsSection>
  )
}

/** What the row is, then who edits it. */
function aboutLine(item: AgentContextItem): string {
  return `${item.description} ${item.editedBy}.`
}

/**
 * The row's label; on the Agent page, where the section mixes rows that shape
 * everyone's replies with ones that shape only yours, each row carries its audience.
 */
function ItemLabel({ item, variant }: { item: AgentContextItem; variant: "section" | "panel" }) {
  if (variant === "panel") return item.label
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {item.label}
      <AudienceBadge audience={item.audience} />
    </span>
  )
}

/** Label, what it is and who edits it; a prose value previews on its own line beneath. */
function RowText({ item, variant }: { item: AgentContextItem; variant: "section" | "panel" }) {
  return (
    <>
      <span className="block text-sm font-medium leading-snug">
        <ItemLabel item={item} variant={variant} />
      </span>
      <span className={cn("mt-0.5 block text-muted-foreground", SETTING_NOTE_TEXT)}>{aboutLine(item)}</span>
      {item.prose && <span className="mt-1 block min-w-0 truncate text-sm text-foreground">{item.value}</span>}
    </>
  )
}

/** A row that opens in place to show its full text, so anyone can read what they can't edit. */
function AgentContextDetailRow({
  item,
  href,
  variant,
}: {
  item: AgentContextItem
  href: string | null
  variant: "section" | "panel"
}) {
  const [open, setOpen] = useState(false)
  const regionId = useId()
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex min-h-11 w-full items-center gap-3 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
          variant === "section" ? "px-4 py-3" : "rounded-md px-2 py-1.5"
        )}
      >
        <SettingValueRowBody
          compact={variant === "panel"}
          text={<RowText item={item} variant={variant} />}
          value={item.prose ? undefined : item.value}
          chevron={
            <ChevronDown
              className={cn(SETTING_ROW_CHEVRON_CLASS, "motion-safe:transition-transform", open && "rotate-180")}
              aria-hidden
            />
          }
        />
      </button>
      {open && (
        <div id={regionId} className={cn("space-y-2 pb-3", variant === "section" ? "px-4" : "px-2")}>
          <div className={cn("break-words sm:max-h-64 sm:overflow-y-auto", SETTING_INPUT_FRAME)}>
            <MarkdownContent content={item.detail ?? ""} className="text-sm leading-relaxed" />
          </div>
          {href && (
            <p className="text-sm">
              <SettingsLink to={href} replace={false}>
                Edit agent
              </SettingsLink>
            </p>
          )}
        </div>
      )}
    </>
  )
}
