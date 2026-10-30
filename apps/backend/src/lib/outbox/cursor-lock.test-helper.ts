import { mock, spyOn } from "bun:test"
import * as cursorLockModule from "@threahq/backend-common"
import type { ProcessResult } from "@threahq/backend-common"

export function mockCursorLock(onRun?: (result: ProcessResult) => void | Promise<void>): Promise<ProcessResult> {
  const { promise: completed, resolve, reject } = Promise.withResolvers<ProcessResult>()
  ;(spyOn(cursorLockModule, "CursorLock") as any).mockImplementation(() => ({
    run: mock(async (processor: (cursor: bigint, processedIds: bigint[]) => Promise<ProcessResult>) => {
      try {
        const result = await processor(0n, [])
        await onRun?.(result)
        resolve(result)
      } catch (error) {
        reject(error)
      }
    }),
  }))
  return completed
}
