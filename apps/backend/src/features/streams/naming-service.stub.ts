import type { StreamNamingServiceLike } from "./naming-worker"
import { logger } from "../../lib/logger"

/** Test stub: never performs naming, always returns false. */
export class StubStreamNamingService implements StreamNamingServiceLike {
  async attemptAutoNaming(streamId: string, _requireName: boolean): Promise<boolean> {
    logger.debug({ streamId }, "Stub naming service - skipping auto-naming")
    return false
  }
}
