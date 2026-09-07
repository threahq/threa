import posthog from "@posthog/rollup-plugin"
import type { Plugin } from "vite"

type PostHogEnvironment = Pick<NodeJS.ProcessEnv, "POSTHOG_CLI_TOKEN" | "POSTHOG_ENV_ID_EU" | "POSTHOG_ENV_ID_US">

export function postHogSourceMapPlugins(env: PostHogEnvironment = process.env): Plugin[] {
  const personalApiKey = env.POSTHOG_CLI_TOKEN?.trim()
  const euProjectId = env.POSTHOG_ENV_ID_EU?.trim()
  const usProjectId = env.POSTHOG_ENV_ID_US?.trim()
  if (!personalApiKey || !euProjectId) return []

  const plugin = (projectId: string, host: string, deleteAfterUpload: boolean): Plugin => ({
    ...posthog({
      personalApiKey,
      projectId,
      host,
      sourcemaps: {
        releaseMode: "symbol-set",
        deleteAfterUpload,
      },
    }),
    apply: "build",
  })

  return [
    plugin(euProjectId, "https://eu.posthog.com", !usProjectId),
    ...(usProjectId ? [plugin(usProjectId, "https://us.posthog.com", true)] : []),
  ]
}
