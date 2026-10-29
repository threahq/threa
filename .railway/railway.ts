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

  const options = {
    variables: { managed: false },
    resources: [enclave],
  } satisfies ProjectOptions

  return project("threa", options)
})
