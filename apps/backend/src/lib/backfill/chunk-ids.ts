/** Rows per chunk when a backfill fans a workspace's ids out into chunk jobs. */
export const DEFAULT_BACKFILL_CHUNK_SIZE = 500

/** Split ids into chunk-sized slices, preserving order. */
export function chunkIds(ids: string[], size: number = DEFAULT_BACKFILL_CHUNK_SIZE): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size))
  }
  return chunks
}
