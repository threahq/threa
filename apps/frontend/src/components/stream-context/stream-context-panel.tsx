import { useFeatureFlag } from "@/hooks"
import { StreamContextDerivedPanel, type StreamContextPanelProps } from "./stream-context-derived-panel"
import { StreamContextIndexPanel } from "./stream-context-index-panel"

export type { StreamContextPanelProps }

/**
 * "In this stream" — the backend-indexed feed when `streamContextIndex` is on,
 * otherwise the loaded-window derive path. The index path itself falls back to
 * derive for sealed streams, which the server never indexes.
 */
export function StreamContextPanel(props: StreamContextPanelProps) {
  const indexed = useFeatureFlag(props.workspaceId, "streamContextIndex") === "on"
  return indexed ? <StreamContextIndexPanel {...props} /> : <StreamContextDerivedPanel {...props} />
}
