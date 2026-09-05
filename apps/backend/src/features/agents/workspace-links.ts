/**
 * Relative workspace URLs shared by agent tools, the researcher's source
 * citations, and the researcher's formatted retrieval context. Paths carry no
 * origin — the frontend resolves them against the current host.
 */

export function workspaceMessageUrl(workspaceId: string, streamId: string, messageId: string): string {
  return `/w/${workspaceId}/s/${streamId}?m=${messageId}`
}

export function workspaceStreamUrl(workspaceId: string, streamId: string): string {
  return `/w/${workspaceId}/s/${streamId}`
}

export function workspaceMemoUrl(workspaceId: string, memoId: string): string {
  return `/w/${workspaceId}/memory?memo=${memoId}`
}

export function workspaceHomeUrl(workspaceId: string): string {
  return `/w/${workspaceId}`
}
