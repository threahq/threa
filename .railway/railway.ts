import { defineRailway, github, project, service } from "railway/iac"

type ProjectOptions = Parameters<typeof project>[1] & {
  variables: {
    managed: boolean
  }
}

export const partial = "enclave"

export default defineRailway(() => {
  const enclave = service("enclave", {
    source: github("threahq/threa", { branch: "main", checkSuites: false }),
    build: {
      buildEnvironment: "V3",
      builder: "RAILPACK",
      watchPatterns: [
        "package.json",
        "bun.lock",
        ".dockerignore",
        "Dockerfile.enclave",
        "patches/**",
        "apps/*/package.json",
        "apps/enclave/**",
        "packages/*/package.json",
        "packages/types/**",
        "packages/prosemirror/**",
        "packages/crypto/**",
        "packages/agent-runtime/**",
      ],
    },
    healthcheck: "/readyz",
    replicas: { "europe-west4-drams3a": 1 },
  })

  const pgCacheDrop = service("pg-cache-drop", {
    source: github("threahq/threa", { branch: "main", checkSuites: false }),
    build: {
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile.pg-cache-drop",
      watchPatterns: ["apps/pg-cache-drop/**", "Dockerfile.pg-cache-drop"],
    },
    deploy: {
      cronSchedule: "15 */4 * * *",
      restartPolicyType: "NEVER",
    },
    replicas: { "europe-west4-drams3a": 1 },
  })

  const options = {
    variables: { managed: false },
    resources: [enclave, pgCacheDrop],
  } satisfies ProjectOptions

  return project("threa", options)
})
