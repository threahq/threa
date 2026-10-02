/**
 * Interface for image caption services.
 * Implemented by both the real service (LLM-powered) and stub service (no-op).
 */
export interface ImageCaptionServiceLike {
  processImage(workspaceId: string, attachmentId: string): Promise<void>
}
