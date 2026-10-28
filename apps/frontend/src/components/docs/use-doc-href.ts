import { useOptionalPanel } from "@/contexts"

/** Where a doc link goes: a pane beside the current stream when there is one, else the doc's own page. */
export function useDocHref(workspaceId: string | undefined, docId: string | undefined): string | null {
  const panel = useOptionalPanel()
  if (!workspaceId || !docId) return null
  return panel ? panel.getPanelUrl(docId) : `/w/${workspaceId}/s/${docId}`
}
