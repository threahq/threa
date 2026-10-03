/**
 * Interface for text processing services.
 * Implemented by both the real service (parse-based) and stub service (no-op).
 */
export interface TextProcessingServiceLike {
  processText(workspaceId: string, attachmentId: string): Promise<void>
}
