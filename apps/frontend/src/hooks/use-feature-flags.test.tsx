import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  FEATURE_FLAG_DEFINITIONS,
  type FeatureFlagDefinition,
  type FeatureFlagKey,
  type FeatureFlagLayers,
  type WorkspaceBootstrap,
} from "@threa/types"
import { db } from "@/db"
import { resetWorkspaceStoreCache } from "@/stores/workspace-store"
import { workspaceKeys } from "./use-workspaces"
import { useFeatureFlag, useOverriddenFeatureFlags } from "./use-feature-flags"

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

// These layering/provenance cases need flags with specific scopes and defaults
// that the shipped registry doesn't carry, so inject a stand-in registry
// (visible to the code-bound predicates + resolver, which read
// FEATURE_FLAG_DEFINITIONS dynamically) and clear it after each test rather
// than committing test-only flags to @threa/types. `warmStart` is default-on: the
// case the persistence fix protects — a warm paint must not flash the default.
const STANDIN_REGISTRY = {
  warmStart: { values: ["off", "on"], scopes: ["workspace", "user"], default: "on" },
  wsOnly: { values: ["off", "on"], scopes: ["workspace"], default: "off" },
} as const satisfies Record<string, FeatureFlagDefinition>

function injectRegistry() {
  Object.assign(FEATURE_FLAG_DEFINITIONS, STANDIN_REGISTRY)
}

function resetRegistry() {
  for (const key of Object.keys(STANDIN_REGISTRY)) delete FEATURE_FLAG_DEFINITIONS[key]
}

function cacheBootstrapLayers(queryClient: QueryClient, workspaceId: string, featureFlags: FeatureFlagLayers): void {
  queryClient.setQueryData(workspaceKeys.bootstrap(workspaceId), { featureFlags } as WorkspaceBootstrap)
}

async function persistMetadataLayers(workspaceId: string, featureFlags: FeatureFlagLayers): Promise<void> {
  await db.workspaceMetadata.put({
    id: workspaceId,
    workspaceId,
    emojis: [],
    emojiWeights: {},
    commands: [],
    featureFlags,
    _cachedAt: Date.now(),
  })
}

describe("useOverriddenFeatureFlags", () => {
  it("returns no overridden flags before the bootstrap is cached", () => {
    const queryClient = new QueryClient()
    const { result } = renderHook(() => useOverriddenFeatureFlags("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    expect(result.current).toEqual([])
  })

  it("consumes the layered bootstrap shape and drops keys not in the registry", () => {
    const queryClient = new QueryClient()
    const layers: FeatureFlagLayers = { workspace: { calls: "off" }, user: { newComposer: "on" } }
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), { featureFlags: layers } as WorkspaceBootstrap)

    const { result } = renderHook(() => useOverriddenFeatureFlags("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    // `calls` is the shipped workspace-scope flag (default on): an off override
    // surfaces. `newComposer` is not in the registry, so it is dropped.
    expect(result.current).toEqual([{ key: "calls", value: "off", defaultValue: "on", scope: "workspace" }])
  })
})

describe("feature flags — first render off persisted layers", () => {
  beforeEach(async () => {
    await db.workspaceMetadata.clear()
    resetWorkspaceStoreCache()
    injectRegistry()
  })

  afterEach(async () => {
    cleanup()
    resetRegistry()
    await db.workspaceMetadata.clear()
    resetWorkspaceStoreCache()
  })

  it("returns the persisted workspace value, not the registry default, on a warm start with an empty query cache", async () => {
    // Warm start: no bootstrap in the query cache yet, but IDB metadata carries
    // a workspace override of "off" for a default-ON flag. The old query-cache-
    // only read would return the "on" default here.
    const queryClient = new QueryClient()
    await persistMetadataLayers("ws_1", { workspace: { warmStart: "off" }, user: {} })

    const { result } = renderHook(() => useFeatureFlag("ws_1", "warmStart" as FeatureFlagKey), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current).toBe("off"))
  })

  it("prefers the live query cache over the persisted layers when both are present", async () => {
    const queryClient = new QueryClient()
    // IDB persisted "off"; the live (socket-patched) query cache says "on".
    await persistMetadataLayers("ws_1", { workspace: { warmStart: "off" }, user: {} })
    cacheBootstrapLayers(queryClient, "ws_1", { workspace: { warmStart: "on" }, user: {} })

    const { result } = renderHook(() => useFeatureFlag("ws_1", "warmStart" as FeatureFlagKey), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current).toBe("on"))
  })

  it("survives a legacy flat featureFlags map persisted before the layered shape", async () => {
    // Pre-#1455 clients persisted the flat resolved map (empty registry → `{}`).
    // Reading it as layers crashed the first render (Object.entries(undefined))
    // before any bootstrap could rewrite the row — the app must instead render
    // registry defaults.
    const queryClient = new QueryClient()
    await persistMetadataLayers("ws_1", {} as FeatureFlagLayers)

    const { result } = renderHook(() => useFeatureFlag("ws_1", "warmStart" as FeatureFlagKey), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current).toBe("on"))
  })

  it("survives a legacy flat featureFlags map in the cached bootstrap", async () => {
    const queryClient = new QueryClient()
    cacheBootstrapLayers(queryClient, "ws_1", { warmStart: "off" } as unknown as FeatureFlagLayers)

    const { result } = renderHook(() => useOverriddenFeatureFlags("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    // The flat keys are unlayerable and dropped — no overrides, no crash.
    expect(result.current).toEqual([])
  })

  it("coerces malformed layer records per key, keeping the valid sibling layer", async () => {
    // Corrupted persistence: an array where a layer record should be, next to a
    // valid user layer. The malformed layer coerces to {}; the valid override
    // still applies.
    const queryClient = new QueryClient()
    await persistMetadataLayers("ws_1", {
      workspace: ["not", "a", "record"],
      user: { warmStart: "off" },
    } as unknown as FeatureFlagLayers)

    const { result } = renderHook(() => useFeatureFlag("ws_1", "warmStart" as FeatureFlagKey), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current).toBe("off"))
  })

  it("discards a layer record carrying non-string values", async () => {
    const queryClient = new QueryClient()
    await persistMetadataLayers("ws_1", {
      workspace: { warmStart: 123 },
      user: {},
    } as unknown as FeatureFlagLayers)

    const { result } = renderHook(() => useFeatureFlag("ws_1", "warmStart" as FeatureFlagKey), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current).toBe("on"))
  })

  it("treats a cached bootstrap with no layers as authoritative, not a fall-through to stale IDB", async () => {
    // A bootstrap is cached but carries no featureFlags (older server / no
    // overrides = all defaults). IDB still holds a stale "off". The present
    // bootstrap must win: the flag resolves to its default "on", not the IDB value.
    const queryClient = new QueryClient()
    await persistMetadataLayers("ws_1", { workspace: { warmStart: "off" }, user: {} })
    queryClient.setQueryData(workspaceKeys.bootstrap("ws_1"), { featureFlags: undefined } as WorkspaceBootstrap)

    const { result } = renderHook(() => useFeatureFlag("ws_1", "warmStart" as FeatureFlagKey), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => expect(result.current).toBe("on"))
  })
})

describe("useOverriddenFeatureFlags — provenance", () => {
  afterEach(() => {
    cleanup()
    resetRegistry()
  })

  it("labels a workspace-layer override with workspace scope", () => {
    injectRegistry()
    const queryClient = new QueryClient()
    cacheBootstrapLayers(queryClient, "ws_1", { workspace: { wsOnly: "on" }, user: {} })

    const { result } = renderHook(() => useOverriddenFeatureFlags("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    expect(result.current).toEqual([{ key: "wsOnly", value: "on", defaultValue: "off", scope: "workspace" }])
  })

  it("labels a user override with user scope, and user wins when both layers set the key", () => {
    injectRegistry()
    const queryClient = new QueryClient()
    cacheBootstrapLayers(queryClient, "ws_1", { workspace: { warmStart: "off" }, user: { warmStart: "off" } })

    const { result } = renderHook(() => useOverriddenFeatureFlags("ws_1"), {
      wrapper: createWrapper(queryClient),
    })

    // Both layers set warmStart=off (non-default); the user layer applies last,
    // so the winning scope is "user".
    expect(result.current).toEqual([{ key: "warmStart", value: "off", defaultValue: "on", scope: "user" }])
  })
})
