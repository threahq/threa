/**
 * Interface for Word processing services.
 * Implemented by both the real service and stub service.
 */
export interface WordProcessingServiceLike {
  processWord(workspaceId: string, attachmentId: string): Promise<void>
}
