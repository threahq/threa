import { describe, expect, test } from "bun:test"

import { MAX_RESULTS, highlightRanges, prepareIndex, search, splitWords, type SearchEntry } from "../src/lib/search"

const entry = (kind: SearchEntry["kind"], title: string, extra: Partial<SearchEntry> = {}): SearchEntry => ({
  kind,
  title,
  url: `/developers/x#${title}`,
  where: "",
  ...extra,
})

const titles = (entries: SearchEntry[], query: string) => search(prepareIndex(entries), query).map((h) => h.entry.title)

describe("splitWords", () => {
  test("splits camel, Pascal, snake, kebab and path separators", () => {
    expect(splitWords("createOrder")).toEqual(["create", "order"])
    expect(splitWords("CreateOrder")).toEqual(["create", "order"])
    expect(splitWords("create_order")).toEqual(["create", "order"])
    expect(splitWords("create-order")).toEqual(["create", "order"])
    expect(splitWords("/streams/{streamId}/messages")).toEqual(["streams", "stream", "id", "messages"])
    expect(splitWords("getHTTPResponse")).toEqual(["get", "http", "response"])
    expect(splitWords("listStreamE2eKeyWraps")).toEqual(["list", "stream", "e2e", "key", "wraps"])
  })
})

describe("search", () => {
  const op = entry("operation", "Create an order", { aliases: ["createOrder", "POST /orders"] })

  test("finds an operationId however the query spells it", () => {
    for (const query of ["createOrder", "createorder", "create order", "create_order", "CreateOrder", "Create-Order"]) {
      expect({ query, titles: titles([op], query) }).toEqual({ query, titles: ["Create an order"] })
    }
  })

  test("ranks exact over whole words over word prefixes over substrings", () => {
    const entries = [
      entry("field", "unarchived"),
      entry("field", "archivedAt"),
      entry("field", "archiving"),
      entry("field", "archived"),
    ]
    expect(titles(entries, "archived")).toEqual(["archived", "archivedAt", "unarchived"])
    expect(titles(entries, "archiv")).toEqual(["archived", "archiving", "archivedAt", "unarchived"])
  })

  test("breaks ties by kind, then by shorter title", () => {
    const entries = [
      entry("field", "stream"),
      entry("operation", "Get a stream"),
      entry("heading", "Streams and threads"),
      entry("page", "Streams"),
      entry("heading", "Streams"),
    ]
    expect(titles(entries, "streams")).toEqual(["Streams", "Streams", "Streams and threads"])
    expect(titles(entries, "stream")).toEqual(["stream", "Get a stream", "Streams", "Streams", "Streams and threads"])
  })

  test("requires every token of a multi-word query", () => {
    const entries = [
      entry("heading", "Send a message"),
      entry("heading", "Send a file"),
      entry("heading", "Read a message"),
    ]
    expect(titles(entries, "send message")).toEqual(["Send a message"])
  })

  test("lets context narrow a query without matching on context alone", () => {
    const entries = [
      entry("field", "content", { context: ["Send a message", "sendMessage", "request body"] }),
      entry("field", "content", { context: ["Update a label", "updateLabel", "request body"] }),
    ]
    expect(search(prepareIndex(entries), "sendMessage content").map((h) => h.entry.context?.[1])).toEqual([
      "sendMessage",
    ])
    expect(titles(entries, "sendMessage")).toEqual([])
  })

  test("returns at most the top results", () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry("field", `field${i}`))
    expect(search(prepareIndex(entries), "field")).toHaveLength(MAX_RESULTS)
  })

  test("returns nothing for an empty query", () => {
    expect(titles([op], "  ./ ")).toEqual([])
  })
})

describe("highlightRanges", () => {
  test("marks the matched span in the original text", () => {
    expect(highlightRanges("listStreamMessages", "stream")).toEqual([[4, 10]])
    expect(highlightRanges("Send a message", "mess")).toEqual([[7, 11]])
  })

  test("marks a joined query across separators", () => {
    expect(highlightRanges("create_order", "createorder")).toEqual([[0, 12]])
  })

  test("marks each token when they sit apart", () => {
    expect(highlightRanges("Send a message", "send message")).toEqual([
      [0, 4],
      [7, 14],
    ])
  })

  test("marks nothing when nothing matches", () => {
    expect(highlightRanges("Send a message", "label")).toEqual([])
  })
})
