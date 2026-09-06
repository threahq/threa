import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  readStoredSearchResultDisplayMode,
  useStoredSearchResultDisplayMode,
  writeStoredSearchResultDisplayMode,
} from "./search-result-display-mode"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("search result display mode", () => {
  it("keeps preferences isolated by workspace", () => {
    writeStoredSearchResultDisplayMode("workspace_1", "ranked")

    expect(readStoredSearchResultDisplayMode("workspace_1")).toBe("ranked")
    expect(readStoredSearchResultDisplayMode("workspace_2")).toBe("clusters")
  })

  it("falls back to clusters when localStorage cannot be read or written", () => {
    const getItem = vi.fn(() => {
      throw new Error("Storage unavailable")
    })
    const setItem = vi.fn(() => {
      throw new Error("Storage unavailable")
    })
    vi.stubGlobal("localStorage", { getItem, setItem })

    expect(readStoredSearchResultDisplayMode("workspace_1")).toBe("clusters")
    expect(() => writeStoredSearchResultDisplayMode("workspace_1", "ranked")).not.toThrow()
    expect(setItem).toHaveBeenCalledWith("threa-search-result-display:workspace_1", "ranked")
  })

  it("reloads the workspace-specific preference when the workspace changes", () => {
    writeStoredSearchResultDisplayMode("workspace_2", "ranked")
    const { result, rerender } = renderHook(({ workspaceId }) => useStoredSearchResultDisplayMode(workspaceId), {
      initialProps: { workspaceId: "workspace_1" },
    })

    expect(result.current[0]).toBe("clusters")
    rerender({ workspaceId: "workspace_2" })
    expect(result.current[0]).toBe("ranked")

    act(() => result.current[1]("clusters"))
    expect(readStoredSearchResultDisplayMode("workspace_2")).toBe("clusters")
    expect(readStoredSearchResultDisplayMode("workspace_1")).toBe("clusters")
  })
})
