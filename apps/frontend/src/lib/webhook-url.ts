export interface IncomingWebhookUrls {
  url: string
  slackUrl: string
}

export function buildIncomingWebhookUrls(
  origin: string,
  workspaceId: string,
  hookId: string,
  secret: string
): IncomingWebhookUrls {
  const url = `${origin.replace(/\/+$/, "")}/api/v1/workspaces/${workspaceId}/hooks/${hookId}/${secret}`
  return { url, slackUrl: `${url}/slack` }
}
