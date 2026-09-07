export {}

declare global {
  interface Window {
    __fixtureVersion?: string
    __fixtureBuildId?: string
    __fixtureLazyUrl?: string
    __importLazyFixture?: () => Promise<string>
    __appUpdateState?: {
      phase: string
      readyBuildId: string | null
      failure: string | null
    }
  }
}
