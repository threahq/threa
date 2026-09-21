export function buildIncomingWebhookUrls(
  origin: string,
  workspaceId: string,
  hookId: string,
  secret: string
): { url: string; slackUrl: string } {
  const url = `${origin.replace(/\/+$/, "")}/api/v1/workspaces/${workspaceId}/hooks/${hookId}/${secret}`
  return { url, slackUrl: `${url}/slack` }
}
