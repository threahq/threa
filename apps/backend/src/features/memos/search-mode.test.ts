import { describe, expect, it } from "bun:test"
import { KNOWLEDGE_TYPES, STREAM_TYPES } from "@threa/types"
import {
  DEFAULT_MEMO_SEARCH_MODE,
  MEMO_BOOST_DEFAULT,
  MEMO_KNOWLEDGE_TYPE_BOOST,
  MEMO_SEARCH_MODES,
  MEMO_STREAM_TYPE_BOOST,
  resolveMemoSearchMode,
} from "./config"

describe("resolveMemoSearchMode", () => {
  it("defaults to the balanced mode", () => {
    expect(resolveMemoSearchMode()).toEqual(MEMO_SEARCH_MODES[DEFAULT_MEMO_SEARCH_MODE])
    expect(DEFAULT_MEMO_SEARCH_MODE).toBe("balanced")
  })

  it("resolves each named mode to its bundle", () => {
    expect(resolveMemoSearchMode("fast")).toEqual({ limit: 30, candidatePoolSize: 30, rerank: false })
    expect(resolveMemoSearchMode("balanced")).toEqual({ limit: 30, candidatePoolSize: 50, rerank: true })
    expect(resolveMemoSearchMode("thorough")).toEqual({ limit: 50, candidatePoolSize: 80, rerank: true })
  })

  it("keeps candidate pool >= final limit so trim never starves results", () => {
    for (const mode of Object.values(MEMO_SEARCH_MODES)) {
      expect(mode.candidatePoolSize).toBeGreaterThanOrEqual(mode.limit)
    }
  })
})

describe("structural boost maps", () => {
  it("covers every knowledge type with a positive factor", () => {
    for (const type of KNOWLEDGE_TYPES) {
      expect(MEMO_KNOWLEDGE_TYPE_BOOST[type]).toBeGreaterThan(0)
    }
  })

  it("covers every stream type with a positive factor", () => {
    for (const type of STREAM_TYPES) {
      expect(MEMO_STREAM_TYPE_BOOST[type]).toBeGreaterThan(0)
    }
  })

  it("favours decisions over plain context and de-emphasises system streams", () => {
    expect(MEMO_KNOWLEDGE_TYPE_BOOST.decision).toBeGreaterThan(MEMO_KNOWLEDGE_TYPE_BOOST.context)
    expect(MEMO_STREAM_TYPE_BOOST.system).toBeLessThan(MEMO_BOOST_DEFAULT)
  })
})
