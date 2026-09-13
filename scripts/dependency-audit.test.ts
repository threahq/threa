import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildReport, parseAudit, renderMarkdown } from "./dependency-audit"

const advisory = {
  id: 1,
  url: "https://github.com/advisories/GHSA-test",
  title: "x: bad thing",
  severity: "high",
}

describe("parseAudit", () => {
  test("should parse a valid package -> advisories map", () => {
    const result = parseAudit(JSON.stringify({ ws: [advisory] }))
    expect(result).toEqual({ ws: [advisory] })
  })

  test("should accept an empty map as a clean scan", () => {
    expect(parseAudit("{}")).toEqual({})
  })

  test("should reject non-JSON output", () => {
    expect(() => parseAudit("ECONNRESET")).toThrow("not valid JSON")
  })

  test("should reject JSON that is not an object", () => {
    expect(() => parseAudit("[]")).toThrow("not a package -> advisories map")
  })

  test("should reject an entry that is not an advisory list", () => {
    expect(() => parseAudit(JSON.stringify({ ws: "boom" }))).toThrow('entry for "ws"')
  })

  test("should reject an unknown severity rather than miscount it", () => {
    expect(() => parseAudit(JSON.stringify({ ws: [{ ...advisory, severity: "constructor" }] }))).toThrow(
      'entry for "ws"'
    )
  })
})

describe("buildReport", () => {
  test("should count advisories and severities", () => {
    const report = buildReport({
      ws: [advisory, { ...advisory, severity: "low" }],
      qs: [advisory],
    })
    expect(report).toEqual({
      ok: true,
      packages: 2,
      advisories: 3,
      distinctAdvisories: 1,
      bySeverity: { high: 2, low: 1 },
      result: {
        ws: [advisory, { ...advisory, severity: "low" }],
        qs: [advisory],
      },
    })
  })
})

describe("renderMarkdown", () => {
  test("should render scanner titles as text without forging advisory links", () => {
    const report = buildReport({ ws: [{ ...advisory, title: "safe](https://evil.example) [forged\\suffix" }] })
    const html = Bun.markdown.html(renderMarkdown(report))
    expect([...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1])).toEqual([advisory.url])
  })

  test("should escape pipes in table cells from remote titles", () => {
    const markdown = renderMarkdown(buildReport({ ws: [{ ...advisory, title: "a | b" }] }))
    expect(markdown).toContain("a \\| b")
  })

  test("should encode parens in advisory URLs so they cannot break the link", () => {
    const markdown = renderMarkdown(buildReport({ ws: [{ ...advisory, url: "https://github.com/advisories/GH(s)" }] }))
    expect(markdown).toContain("(https://github.com/advisories/GH%28s%29)")
  })

  test("should not link a non-https advisory URL", () => {
    const markdown = renderMarkdown(buildReport({ ws: [{ ...advisory, url: "javascript:alert(1)" }] }))
    expect(markdown).toContain("URL not https, see artifact")
    expect(markdown).not.toContain("javascript:alert(1)](")
  })
})

describe("report command", () => {
  test.each([
    { scenario: "a clean scan", scannerExit: 0, stdout: "{}", success: true },
    { scenario: "unresolved findings", scannerExit: 1, stdout: JSON.stringify({ ws: [advisory] }), success: true },
    { scenario: "a scanner failure", scannerExit: 2, stdout: "{}", success: false },
    { scenario: "malformed output", scannerExit: 1, stdout: "connection failed", success: false },
    { scenario: "a failed scan without findings", scannerExit: 1, stdout: "{}", success: false },
  ])("should report honestly for $scenario", ({ scannerExit, stdout, success }) => {
    const dir = mkdtempSync(join(tmpdir(), "threa-advisory-test-"))
    try {
      const command = join(dir, "bun")
      writeFileSync(command, '#!/bin/sh\nprintf "%s" "$AUDIT_TEST_OUTPUT"\nexit "$AUDIT_TEST_EXIT"\n')
      chmodSync(command, 0o755)
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "dependency-audit.ts")], {
        cwd: dir,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          AUDIT_TEST_OUTPUT: stdout,
          AUDIT_TEST_EXIT: String(scannerExit),
          GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      })
      expect({
        succeeded: result.exitCode === 0,
        artifact: existsSync(join(dir, "dependency-audit.json")),
        summary: existsSync(join(dir, "summary.md")),
      }).toEqual({ succeeded: success, artifact: success, summary: success })
      if (success) {
        expect(JSON.parse(readFileSync(join(dir, "dependency-audit.json"), "utf8")).result).toEqual(JSON.parse(stdout))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
