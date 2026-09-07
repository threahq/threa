import type { AppUpdateState } from "../../../apps/frontend/src/lib/app-update"

declare global {
  interface Window {
    __fixtureVersion?: string
    __fixtureBuildId?: string
    __fixtureLazyUrl?: string
    __importLazyFixture?: () => Promise<string>
    __appUpdateState?: Pick<AppUpdateState, "phase" | "readyBuildId" | "failure" | "lastCheckedAt">
  }
}
