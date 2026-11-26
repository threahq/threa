/**
 * Storage key for an object the backend derives from an attachment. Uploads are stored at
 * `{workspace}/{attachment}/{filename}` under the filename as sent, so a derived object under that prefix
 * would replace an upload that happens to carry its name.
 */
export function derivedStoragePath(workspaceId: string, attachmentId: string, name: string): string {
  return `${workspaceId}/derived/${attachmentId}/${name}`
}
