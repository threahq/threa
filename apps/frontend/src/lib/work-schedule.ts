import { type WorkSchedule, DEFAULT_WORK_SCHEDULE } from "@threa/types"

/**
 * Resolve the working schedule that applies to a viewer: their personal
 * override wins, then the workspace default, then the hardcoded Mon–Fri 09:00.
 * Mirrors the backend resolution chain so preset math matches what a server
 * would compute.
 */
export function resolveWorkSchedule(
  userSchedule: WorkSchedule | null | undefined,
  workspaceDefault: WorkSchedule | null | undefined
): WorkSchedule {
  return userSchedule ?? workspaceDefault ?? DEFAULT_WORK_SCHEDULE
}
