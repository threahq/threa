import type { FeatureFlagKey, FeatureFlagValue } from "@threahq/types"
import { SettingBadge, SettingEmptyNote, SETTING_ITEM_DIVIDERS } from "@/components/settings/setting-primitives"
import { SETTING_NOTE_TEXT } from "@/components/settings/setting-text"
import { cn } from "@/lib/utils"
import { useOverriddenFeatureFlags } from "@/hooks/use-feature-flags"

interface FeatureFlagsTabProps {
  workspaceId: string
}

/** Every flag needs copy here, so a new flag can't reach the list as a raw key. */
const FLAG_COPY: { [K in FeatureFlagKey]: { label: string; description: string } } = {
  batchedLiveWrites: {
    label: "Batched background updates",
    description: "Saves updates from streams you're not viewing together.",
  },
  idbRelaxedDurability: {
    label: "Faster local cache",
    description: "Cached data saves without waiting for the disk. Drafts and unsent messages still wait.",
  },
  sqliteStorage: { label: "SQLite storage", description: "Keeps this device's data in SQLite." },
  calls: { label: "Calls", description: "Voice and video calls in streams." },
  callsP2p: { label: "Direct calls", description: "Calls connect straight between people when they can." },
  composeTraces: { label: "Composer traces", description: "Records send timings to help fix slow sends." },
  perfDiagnostics: {
    label: "Performance diagnostics",
    description: "Adds Performance diagnostics to Privacy & security.",
  },
  search: { label: "New search", description: "Reworked ranking, deep search, and memory and conversation groups." },
  searchQueryLog: {
    label: "Search logging",
    description: "Keeps your searches and what you opened, to improve search.",
  },
  streamConnections: { label: "Threa Connect", description: "Share channels with other workspaces." },
}

const VALUE_LABELS: Record<FeatureFlagValue, string> = {
  off: "Off",
  on: "On",
  available: "Available",
  capture: "Capturing",
  shadow: "Shadow copy",
  "read-only": "Reads from SQLite",
  "read-write": "Reads and writes SQLite",
}

/**
 * Read-only view of the viewer's feature flags that differ from the default.
 * Flags at their default value are intentionally not listed, and the tab
 * itself is hidden by the dialog when this list is empty — flag state never
 * leaks beyond what is actually enabled for the viewer.
 */
export function FeatureFlagsTab({ workspaceId }: FeatureFlagsTabProps) {
  const flags = useOverriddenFeatureFlags(workspaceId)

  if (flags.length === 0) return <SettingEmptyNote>No early features are on for you.</SettingEmptyNote>

  return (
    <ul className={SETTING_ITEM_DIVIDERS}>
      {flags.map(({ key, value, defaultValue, scope }) => (
        <li key={key} className="flex min-h-11 items-start justify-between gap-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{FLAG_COPY[key].label}</p>
            <p className={cn("mt-0.5 text-muted-foreground", SETTING_NOTE_TEXT)}>{FLAG_COPY[key].description}</p>
            <p className={cn("mt-0.5 text-muted-foreground", SETTING_NOTE_TEXT)}>
              {scope === "user" ? "Rolling out to you" : "Rolling out to this workspace"} · normally{" "}
              {VALUE_LABELS[defaultValue].toLowerCase()}
            </p>
          </div>
          <SettingBadge>{VALUE_LABELS[value]}</SettingBadge>
        </li>
      ))}
    </ul>
  )
}
