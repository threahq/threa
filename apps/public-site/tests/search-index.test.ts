import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { prepareIndex, search, type SearchEntry } from "../src/lib/search"

const dist = fileURLToPath(new URL("../dist", import.meta.url))
const index: SearchEntry[] = JSON.parse(readFileSync(join(dist, "developers/search-index.json"), "utf8"))
const prepared = prepareIndex(index)

describe("docs search index", () => {
  test("covers pages, headings, operations and fields", () => {
    expect(new Set(index.map((e) => e.kind))).toEqual(new Set(["page", "heading", "operation", "field"]))
  })

  test("names the sidebar group a page sits in", () => {
    expect(index.find((e) => e.url === "/developers/authentication")).toMatchObject({
      kind: "page",
      title: "Authentication",
      where: "Page in Get started",
      context: ["Get started"],
    })
  })

  test("links an operation to its anchor with its group and path", () => {
    expect(index.find((e) => e.url === "/developers/reference#sendMessage")).toMatchObject({
      kind: "operation",
      title: "Send a message",
      where: "Endpoint in Messages",
      method: "POST",
      aliases: ["sendMessage", "POST /streams/{streamId}/messages"],
    })
  })

  test("names the resource or endpoint a field belongs to", () => {
    const where = (url: string) => index.find((e) => e.url === `/developers/reference#${url}`)?.where
    expect({
      body: where("sendMessage.body.content"),
      resource: where("sendMessage.response.data.content"),
      nested: where("getMemo.response.data.memo.title"),
      envelope: where("listLabels.response.data.labels"),
    }).toEqual({
      body: "Field in the Send a message request body",
      resource: "Field on Message in Send a message",
      nested: "Field on memo in the Get a memo response",
      envelope: "Field in the List labels response",
    })
  })

  test("finds an operation by its split operationId", () => {
    expect(search(prepared, "send message")[0].entry.url).toBe("/developers/reference#sendMessage")
  })

  test("links every hit to an anchor the page renders", () => {
    const html = new Map<string, string>()
    for (const e of index) {
      const [route, hash] = e.url.split("#")
      const file = join(dist, route, "index.html")
      if (!html.has(file)) html.set(file, readFileSync(file, "utf8"))
      if (hash)
        expect({ url: e.url, found: html.get(file)!.includes(`id="${hash}"`) }).toEqual({ url: e.url, found: true })
    }
  })
})

describe("markdown mirrors", () => {
  const mirrors = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name)
      if (e.isDirectory()) return mirrors(path)
      return /\.md$|^llms.*\.txt$/.test(e.name) ? [path] : []
    })

  test("carry none of the search UI", () => {
    const files = mirrors(dist)
    expect(files.length).toBeGreaterThan(0)
    const leaks = files.filter((f) => /Search docs|docs-search|search-index\.json/.test(readFileSync(f, "utf8")))
    expect(leaks).toEqual([])
  })
})
