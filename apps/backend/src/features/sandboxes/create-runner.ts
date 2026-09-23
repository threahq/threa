import type { SandboxRunnerConfig } from "../../lib/env"
import { DockerSandboxRunner } from "./docker-runner"
import { RailwaySandboxRunner } from "./railway-runner"
import type { SandboxRunner } from "./runner"

export function createSandboxRunner(config: SandboxRunnerConfig): SandboxRunner {
  switch (config.kind) {
    case "docker":
      return new DockerSandboxRunner()
    case "railway":
      return new RailwaySandboxRunner({ token: config.token, environmentId: config.environmentId })
  }
}
