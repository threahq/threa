/**
 * Text Processing Utilities Tests
 */

import { describe, test, expect } from "bun:test"
import { stripMarkdownFences } from "./text-utils"

describe("stripMarkdownFences", () => {
  test("removes ```json fence and normalizes JSON", async () => {
    const input = '```json\n{"key": "value"}\n```'
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe('{"key":"value"}')
  })

  test("removes plain ``` fence", async () => {
    const input = '```\n{"key": "value"}\n```'
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe('{"key":"value"}')
  })

  test("handles leading whitespace before fence", async () => {
    const input = '  \n```json\n{"key": "value"}\n```'
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe('{"key":"value"}')
  })

  test("handles missing closing fence", async () => {
    const input = '```json\n{"key": "value"}'
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe('{"key":"value"}')
  })

  test("handles trailing whitespace after closing fence", async () => {
    const input = '```json\n{"key": "value"}\n```  \n'
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe('{"key":"value"}')
  })

  test("preserves content without fences", async () => {
    const input = '{"key": "value"}'
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe('{"key":"value"}')
  })

  test("handles case-insensitive JSON marker", async () => {
    const input = '```JSON\n{"key": "value"}\n```'
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe('{"key":"value"}')
  })

  test("preserves nested structure", async () => {
    const input = '```json\n{"key": "value", "nested": {"a": 1}}\n```'
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe('{"key":"value","nested":{"a":1}}')
  })

  test("handles empty content", async () => {
    const input = ""
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe("")
  })

  test("handles only fences with no content", async () => {
    const input = "```json\n```"
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe("")
  })

  test("converts snake_case to camelCase", async () => {
    const input = '{"is_gem": false, "knowledge_type": null}'
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe('{"isGem":false,"knowledgeType":null}')
  })

  test("returns cleaned text if JSON parse fails", async () => {
    const input = "```json\nnot valid json\n```"
    const result = await stripMarkdownFences({ text: input })
    expect(result).toBe("not valid json")
  })
})
