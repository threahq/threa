import { describe, test, expect } from "bun:test"
import {
  audioMimeType,
  categoryFromMime,
  isAudioAttachment,
  mimePrefixesForCategory,
  ATTACHMENT_CATEGORIES,
  type AttachmentCategory,
} from "./attachment-categories"

describe("categoryFromMime", () => {
  test("maps common mime types to expected categories", () => {
    const cases: Array<[string, AttachmentCategory]> = [
      ["image/png", "image"],
      ["image/jpeg", "image"],
      ["image/svg+xml", "image"],
      ["video/mp4", "video"],
      ["video/webm", "video"],
      ["audio/mpeg", "audio"],
      ["audio/x-wav", "audio"],
      ["application/pdf", "pdf"],

      ["application/msword", "doc"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "doc"],
      ["application/vnd.oasis.opendocument.text", "doc"],
      ["text/plain", "doc"],

      ["application/vnd.ms-excel", "sheet"],
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sheet"],
      ["text/csv", "sheet"],

      ["application/vnd.ms-powerpoint", "slide"],
      ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "slide"],

      ["application/json", "code"],
      ["application/javascript", "code"],
      ["text/typescript", "code"],
      ["text/x-python", "code"],
      ["text/markdown", "code"],
      ["text/html", "code"],

      ["application/zip", "archive"],
      ["application/x-7z-compressed", "archive"],
      ["application/vnd.rar", "archive"],
    ]

    for (const [mime, expected] of cases) {
      expect(categoryFromMime(mime)).toBe(expected)
    }
  })

  test("ignores parameters and is case-insensitive", () => {
    expect(categoryFromMime("IMAGE/PNG")).toBe("image")
    expect(categoryFromMime("text/plain; charset=utf-8")).toBe("doc")
    expect(categoryFromMime("application/PDF")).toBe("pdf")
  })

  test("falls back to 'other' for unknown / empty input", () => {
    expect(categoryFromMime("application/octet-stream")).toBe("other")
    expect(categoryFromMime("")).toBe("other")
    expect(categoryFromMime(null)).toBe("other")
    expect(categoryFromMime(undefined)).toBe("other")
    expect(categoryFromMime("not-a-mime")).toBe("other")
  })

  test("every documented category has at least one resolving mime", () => {
    // Sanity check: ensure the categories list and the resolver agree.
    // "other" is the fallback so it doesn't need a representative mime.
    const seen = new Set<AttachmentCategory>()
    const samples = [
      "image/png",
      "video/mp4",
      "audio/mpeg",
      "application/pdf",
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/json",
      "application/zip",
      "application/octet-stream",
    ]
    for (const mime of samples) seen.add(categoryFromMime(mime))
    for (const category of ATTACHMENT_CATEGORIES) {
      expect(seen.has(category)).toBe(true)
    }
  })
})

describe("mimePrefixesForCategory", () => {
  test("returns wildcard prefixes for media categories", () => {
    expect(mimePrefixesForCategory("image")).toEqual(["image/%"])
    expect(mimePrefixesForCategory("video")).toEqual(["video/%"])
    expect(mimePrefixesForCategory("audio")).toEqual(["audio/%"])
  })

  test("returns exact mime list for office / archive / code categories", () => {
    const docs = mimePrefixesForCategory("doc")
    expect(docs).toContain("application/msword")
    expect(docs).toContain("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    expect(docs).toContain("text/plain")

    const archives = mimePrefixesForCategory("archive")
    expect(archives).toContain("application/zip")
    expect(archives).toContain("application/x-7z-compressed")

    const code = mimePrefixesForCategory("code")
    expect(code).toContain("application/json")
    expect(code).toContain("text/typescript")
    expect(code).toContain("text/markdown")
  })

  test("'other' returns an empty list — caller handles the negative case", () => {
    expect(mimePrefixesForCategory("other")).toEqual([])
  })
})

describe("isAudioAttachment", () => {
  test("classifies by mime, falling back to extension only for generic mimes", () => {
    const cases: Array<[string, string]> = [
      ["audio/mpeg", "song.bin"],
      ["audio/webm;codecs=opus", "voice.webm"],
      ["application/octet-stream", "memo.M4A"],
      ["", "take.flac"],
      ["video/mp4", "clip.m4a"],
      ["application/octet-stream", "data.bin"],
      ["application/octet-stream", "mp3"],
    ]
    expect(cases.map(([mime, name]) => isAudioAttachment(mime, name))).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
    ])
  })
})

describe("audioMimeType", () => {
  test("keeps a stored audio mime and names one from the extension only for generic mimes", () => {
    const cases: Array<[string | null, string]> = [
      ["audio/webm;codecs=opus", "voice.webm"],
      ["audio/x-m4a", "memo.m4a"],
      ["application/octet-stream", "memo.M4A"],
      [null, "song.mp3"],
      ["", "take.opus"],
      ["video/mp4", "clip.m4a"],
      ["application/octet-stream", "data.bin"],
      ["application/octet-stream", "constructor"],
    ]
    expect(cases.map(([mime, name]) => audioMimeType(mime, name))).toEqual([
      "audio/webm;codecs=opus",
      "audio/x-m4a",
      "audio/mp4",
      "audio/mpeg",
      "audio/ogg",
      null,
      null,
      null,
    ])
  })
})
