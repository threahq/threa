/**
 * Interface for Excel processing services.
 * Implemented by both the real service and stub service.
 */
export interface ExcelProcessingServiceLike {
  processExcel(workspaceId: string, attachmentId: string): Promise<void>
}
