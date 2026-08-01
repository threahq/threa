import { spawn } from "child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"

type Runner = "bun" | "vitest" | "playwright"
type Mode = "backend-unit" | "backend-integration" | "backend-e2e" | "frontend" | "browser"

interface ModeConfig {
  runner: Runner
  cwd: string
  baseOptions: string[]
  defaultPatterns: string[]
}

interface FailureCase {
  file: string
  name: string
  line?: number
  details?: string
}

interface ParseResult {
  total: number
  passed: number
  failed: number
  skipped: number
  failures: FailureCase[]
  infraErrors: string[]
}

interface SplitArgsResult {
  optionArgs: string[]
  patternArgs: string[]
}

const rootDir = path.resolve(import.meta.dir, "..")

const modeConfigs: Record<Mode, ModeConfig> = {
  "backend-unit": {
    runner: "bun",
    cwd: path.join(rootDir, "apps/backend"),
    baseOptions: [],
    defaultPatterns: ["src/"],
  },
  "backend-integration": {
    runner: "bun",
    cwd: path.join(rootDir, "apps/backend"),
    baseOptions: ["--preload", "./tests/setup.ts", "--max-concurrency", "1"],
    defaultPatterns: ["tests/integration/"],
  },
  "backend-e2e": {
    runner: "bun",
    cwd: path.join(rootDir, "apps/backend"),
    baseOptions: ["--preload", "./tests/setup.ts"],
    defaultPatterns: ["tests/e2e/"],
  },
  frontend: {
    runner: "vitest",
    cwd: path.join(rootDir, "apps/frontend"),
    baseOptions: [],
    defaultPatterns: [],
  },
  browser: {
    runner: "playwright",
    cwd: rootDir,
    baseOptions: [],
    defaultPatterns: [],
  },
}

const valueOptionsByRunner: Record<Runner, Set<string>> = {
  bun: new Set([
    "--timeout",
    "--rerun-each",
    "--seed",
    "--coverage-reporter",
    "--coverage-dir",
    "--bail",
    "--test-name-pattern",
    "-t",
    "--reporter",
    "--reporter-outfile",
    "--max-concurrency",
    "--preload",
  ]),
  vitest: new Set([
    "--config",
    "--project",
    "--environment",
    "--pool",
    "--testNamePattern",
    "-t",
    "--reporter",
    "--outputFile",
    "--coverage.provider",
    "--coverage.reporter",
    "--browser",
    "--poolOptions.threads.maxThreads",
    "--poolOptions.threads.minThreads",
  ]),
  playwright: new Set([
    "--config",
    "--project",
    "--grep",
    "--grep-invert",
    "--workers",
    "--retries",
    "--timeout",
    "--reporter",
    "--trace",
    "--output",
    "--shard",
  ]),
}

const booleanOptionsByRunner: Record<Runner, Set<string>> = {
  bun: new Set([
    "--update-snapshots",
    "-u",
    "--todo",
    "--only",
    "--pass-with-no-tests",
    "--concurrent",
    "--randomize",
    "--coverage",
    "--dots",
    "--only-failures",
  ]),
  vitest: new Set([
    "--watch",
    "--run",
    "--silent",
    "--globals",
    "--dom",
    "--browser.headless",
    "--coverage",
    "--changed",
    "--clearScreen",
    "--open",
  ]),
  playwright: new Set([
    "--headed",
    "--debug",
    "--ui",
    "--list",
    "--forbid-only",
    "--fully-parallel",
    "--quiet",
    "--pass-with-no-tests",
    "--update-snapshots",
  ]),
}

function usage(): number {
  console.error(
    "Usage: bun scripts/test-silent.ts <backend-unit|backend-integration|backend-e2e|frontend|browser> [args...]\n" +
      "  Add --verbose to bypass silent mode and stream all test logs.\n" +
      "  CI runs are automatically verbose."
  )
  return 1
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

function parseAttributes(tagAttributes: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const attrRegex = /([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = attrRegex.exec(tagAttributes)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2])
  }
  return attrs
}

function splitArgs(args: string[], runner: Runner): SplitArgsResult {
  const optionArgs: string[] = []
  const patternArgs: string[] = []
  const valueOptions = valueOptionsByRunner[runner]
  const booleanOptions = booleanOptionsByRunner[runner]

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith("-")) {
      patternArgs.push(arg)
      continue
    }

    optionArgs.push(arg)
    if (arg.includes("=")) continue

    if (valueOptions.has(arg)) {
      if (i + 1 < args.length) {
        optionArgs.push(args[i + 1]!)
        i++
      }
      continue
    }

    if (booleanOptions.has(arg)) continue

    if (i + 1 < args.length && !args[i + 1]!.startsWith("-")) {
      optionArgs.push(args[i + 1]!)
      i++
    }
  }

  return { optionArgs, patternArgs }
}

function stripOptions(optionArgs: string[], runner: Runner, blocked: Set<string>): string[] {
  const next: string[] = []
  const valueOptions = valueOptionsByRunner[runner]

  for (let i = 0; i < optionArgs.length; i++) {
    const arg = optionArgs[i]!
    const splitAt = arg.indexOf("=")
    const optionName = splitAt === -1 ? arg : arg.slice(0, splitAt)
    if (blocked.has(optionName)) {
      if (splitAt === -1 && valueOptions.has(optionName) && i + 1 < optionArgs.length) {
        i++
      }
      continue
    }

    next.push(arg)
    if (splitAt !== -1) continue
    if (valueOptions.has(optionName) && i + 1 < optionArgs.length) {
      next.push(optionArgs[i + 1]!)
      i++
    }
  }

  return next
}

async function runCaptured(
  command: string[],
  cwd: string,
  stdoutPath: string,
  stderrPath: string,
  envVars: NodeJS.ProcessEnv = process.env
): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const processHandle = spawn(command[0]!, command.slice(1), {
      cwd,
      env: envVars,
      stdio: ["ignore", "pipe", "pipe"],
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    processHandle.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    })
    processHandle.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
    })

    processHandle.on("error", reject)

    processHandle.on("close", (code) => {
      writeFileSync(stdoutPath, Buffer.concat(stdoutChunks))
      writeFileSync(stderrPath, Buffer.concat(stderrChunks))
      resolve(code ?? 1)
    })
  })
}

async function runVerbose(command: string[], cwd: string, envVars: NodeJS.ProcessEnv = process.env): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const processHandle = spawn(command[0]!, command.slice(1), {
      cwd,
      env: envVars,
      stdio: "inherit",
    })

    processHandle.on("error", reject)
    processHandle.on("close", (code) => resolve(code ?? 1))
  })
}

function parseBunJunit(xml: string): ParseResult {
  const suiteTag = xml.match(/<testsuites\b([^>]*)>/)
  if (!suiteTag) {
    throw new Error("Unable to parse Bun JUnit output")
  }

  const suiteAttrs = parseAttributes(suiteTag[1]!)
  const total = Number(suiteAttrs.tests ?? 0)
  const failed = Number(suiteAttrs.failures ?? 0)
  const skipped = Number(suiteAttrs.skipped ?? 0)
  const passed = Math.max(0, total - failed - skipped)

  const failures: FailureCase[] = []
  const testcaseRegex = /<testcase\b([^>]*?)(?:\s*\/>|>([\s\S]*?)<\/testcase>)/g
  let match: RegExpExecArray | null
  while ((match = testcaseRegex.exec(xml)) !== null) {
    const attrs = parseAttributes(match[1]!)
    const body = match[2] ?? ""
    if (!body.includes("<failure")) continue
    failures.push({
      file: attrs.file ?? "",
      name: attrs.name ?? "Unknown Bun test",
    })
  }

  return {
    total,
    passed,
    failed,
    skipped,
    failures,
    infraErrors: [],
  }
}

function parseVitestJson(content: string): ParseResult {
  const data = JSON.parse(content)
  const total = Number(data.numTotalTests ?? 0)
  const failed = Number(data.numFailedTests ?? 0)
  const skipped = Number(data.numPendingTests ?? 0) + Number(data.numTodoTests ?? 0)
  const passed = Number(data.numPassedTests ?? Math.max(0, total - failed - skipped))

  const failures: FailureCase[] = []
  for (const suiteResult of data.testResults ?? []) {
    const file = String(suiteResult.name ?? "")
    for (const assertion of suiteResult.assertionResults ?? []) {
      if (assertion.status !== "failed") continue
      const failureMessages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : []
      failures.push({
        file,
        name: String(assertion.fullName ?? assertion.title ?? "Unknown Vitest test"),
        details: failureMessages.join("\n").trim(),
      })
    }
  }

  return {
    total,
    passed,
    failed,
    skipped,
    failures,
    infraErrors: [],
  }
}

function extractPlaywrightJson(stdout: string): any {
  const fromLineStart = stdout.indexOf("\n{")
  const firstJsonIndex = fromLineStart === -1 ? stdout.indexOf("{") : fromLineStart + 1
  if (firstJsonIndex === -1) {
    throw new Error("Playwright JSON reporter output was not found")
  }
  return JSON.parse(stdout.slice(firstJsonIndex))
}

function parsePlaywrightJson(stdout: string): ParseResult {
  const data = extractPlaywrightJson(stdout)
  const stats = data.stats ?? {}
  const passed = Number(stats.expected ?? 0)
  const failedFromStats = Number(stats.unexpected ?? 0)
  const flaky = Number(stats.flaky ?? 0)
  const skipped = Number(stats.skipped ?? 0)
  const total = passed + failedFromStats + flaky + skipped

  const failureMap = new Map<string, FailureCase>()
  const walkSuite = (suite: any) => {
    for (const child of suite.suites ?? []) walkSuite(child)
    for (const spec of suite.specs ?? []) {
      const titlePath = Array.isArray(spec.titlePath) ? spec.titlePath.filter((part: string) => !!part) : []
      const name = titlePath.length > 0 ? titlePath.join(" > ") : String(spec.title ?? "Unknown Playwright test")
      const file = String(spec.file ?? spec.location?.file ?? "")
      const line = typeof spec.line === "number" ? spec.line : spec.location?.line

      const testEntries = Array.isArray(spec.tests) ? spec.tests : []
      let failingDetails = ""
      const hasFailure = testEntries.some((testEntry: any) => {
        const results = Array.isArray(testEntry.results) ? testEntry.results : []
        return results.some((result: any) => {
          const status = String(result.status ?? "")
          const failed = status !== "passed" && status !== "skipped"
          if (!failed) return false
          if (result.error?.message) failingDetails = String(result.error.message)
          return true
        })
      })

      if (!hasFailure) continue
      const key = `${file}:${line ?? 0}:${name}`
      if (!failureMap.has(key)) {
        failureMap.set(key, { file, line, name, details: failingDetails })
      }
    }
  }

  for (const suite of data.suites ?? []) walkSuite(suite)

  const infraErrors: string[] = []
  for (const error of data.errors ?? []) {
    if (error?.message) infraErrors.push(String(error.message))
  }

  const failures = Array.from(failureMap.values())
  const computedFailed = failedFromStats > 0 ? failedFromStats : failures.length
  const failed = computedFailed > 0 ? computedFailed : infraErrors.length

  return {
    total: Math.max(total, passed + failed + skipped),
    passed,
    failed,
    skipped,
    failures,
    infraErrors,
  }
}

function summarize(result: ParseResult): void {
  console.log(`${result.passed} successful tests`)
  if (result.failed > 0) {
    console.log(`${result.failed} failing tests`)
  } else {
    console.log("0 failing tests")
  }
}

function hasFileContent(filePath: string): boolean {
  if (!existsSync(filePath)) return false
  try {
    return statSync(filePath).size > 0
  } catch {
    return false
  }
}

function printFailureArtifacts(artifactDir: string, backendLogPath?: string): void {
  console.error(`Failure artifacts kept at: ${artifactDir}`)
  if (backendLogPath && hasFileContent(backendLogPath)) {
    console.error(`Backend logs: ${backendLogPath}`)
  }
}

function buildNamePattern(names: string[]): string {
  if (names.length === 1) {
    return `^.*${escapeRegex(names[0]!)}$`
  }
  const alternatives = names.map((name) => escapeRegex(name)).join("|")
  return `^.*(?:${alternatives})$`
}

async function rerunBunFailures(
  config: ModeConfig,
  optionArgs: string[],
  patterns: string[],
  failures: FailureCase[],
  firstPassStderr: string,
  envVars: NodeJS.ProcessEnv
): Promise<number> {
  const grouped = new Map<string, Set<string>>()
  for (const failure of failures) {
    const file = failure.file || ""
    if (!grouped.has(file)) grouped.set(file, new Set())
    grouped.get(file)!.add(failure.name)
  }

  let exitCode = 0
  const targetsForReplay: Array<{ file: string; names: string[] }> = []
  if (grouped.size === 0) {
    targetsForReplay.push({ file: "", names: [] })
  } else {
    for (const [file, namesSet] of grouped) {
      targetsForReplay.push({ file, names: Array.from(namesSet) })
    }
  }

  for (const target of targetsForReplay) {
    const command = ["bun", "test", ...config.baseOptions, ...optionArgs]
    if (target.file) command.push(target.file)
    if (target.names.length > 0) {
      command.push("--test-name-pattern", buildNamePattern(target.names))
    } else {
      command.push(...patterns)
    }
    command.push("--only-failures")
    const code = await runVerbose(command, config.cwd, envVars)
    if (code !== 0) exitCode = 1
  }

  if (exitCode === 0) {
    console.error("Flaky failures detected (failed first pass, passed replay).")
    printBunFailureSnippets(firstPassStderr, failures)
  }
  return exitCode
}

function printBunFailureSnippets(stderr: string, failures: FailureCase[]): void {
  const lines = stderr.split("\n")
  const seen = new Set<number>()
  let printed = 0
  const maxSnippets = Math.min(failures.length, 12)
  for (const failure of failures.slice(0, maxSnippets)) {
    const shortName = failure.name.includes(" > ") ? failure.name.split(" > ").at(-1)! : failure.name
    const idx = lines.findIndex((line) => {
      if (!line.startsWith("(fail)")) return false
      return line.includes(failure.name) || line.includes(shortName)
    })
    if (idx === -1) continue

    const start = Math.max(0, idx - 25)
    if (seen.has(start)) continue
    seen.add(start)
    const end = Math.min(lines.length, idx + 6)
    console.error("\n--- First-pass failure excerpt ---")
    console.error(lines.slice(start, end).join("\n"))
    printed += 1
  }

  if (printed === 0) {
    console.error("\n--- First-pass stderr ---")
    console.error(stderr)
  }
}

async function rerunVitestFailures(
  config: ModeConfig,
  optionArgs: string[],
  patterns: string[],
  failures: FailureCase[],
  envVars: NodeJS.ProcessEnv
): Promise<number> {
  const grouped = new Map<string, Set<string>>()
  for (const failure of failures) {
    const file = failure.file || ""
    if (!grouped.has(file)) grouped.set(file, new Set())
    grouped.get(file)!.add(failure.name)
  }

  let exitCode = 0
  const targetsForReplay: Array<{ file: string; names: string[] }> = []
  if (grouped.size === 0) {
    targetsForReplay.push({ file: "", names: [] })
  } else {
    for (const [file, namesSet] of grouped) {
      targetsForReplay.push({ file, names: Array.from(namesSet) })
    }
  }

  for (const target of targetsForReplay) {
    const command = ["bunx", "vitest", "run", ...config.baseOptions, ...optionArgs]
    if (target.file) {
      command.push(target.file)
    } else {
      command.push(...patterns)
    }
    if (target.names.length > 0) {
      command.push("-t", buildNamePattern(target.names))
    }
    command.push("--silent=passed-only")
    const code = await runVerbose(command, config.cwd, envVars)
    if (code !== 0) exitCode = 1
  }

  if (exitCode === 0) {
    console.error("Flaky failures detected (failed first pass, passed replay).")
    for (const failure of failures) {
      if (!failure.details) continue
      console.error(`\n--- First-pass failure: ${failure.name} ---`)
      console.error(failure.details)
    }
  }

  return exitCode
}

async function rerunPlaywrightFailures(
  config: ModeConfig,
  optionArgs: string[],
  patterns: string[],
  failures: FailureCase[],
  infraErrors: string[],
  envVars: NodeJS.ProcessEnv
): Promise<number> {
  const targets = Array.from(
    new Set(
      failures
        .filter((failure) => !!failure.file && typeof failure.line === "number")
        .map((failure) => `${failure.file}:${failure.line}`)
    )
  )

  const stillFailing = await probePlaywrightTarget(config, optionArgs, patterns, targets, envVars)
  let exitCode = 0
  if (stillFailing) {
    const command = ["bunx", "playwright", "test", ...config.baseOptions, ...optionArgs, ...patterns]
    if (targets.length > 0) {
      command.push(...targets)
    }
    exitCode = await runVerbose(command, config.cwd, envVars)
  }

  if (exitCode === 0) {
    console.error("Flaky failures detected (failed first pass, passed replay).")
    for (const failure of failures) {
      console.error(`- ${failure.file}${failure.line ? `:${failure.line}` : ""} ${failure.name}`)
      if (failure.details) {
        console.error(failure.details)
      }
    }
    for (const error of infraErrors) {
      console.error(error)
    }
  }

  return exitCode
}

async function probePlaywrightTarget(
  config: ModeConfig,
  optionArgs: string[],
  patterns: string[],
  targets: string[],
  envVars: NodeJS.ProcessEnv
): Promise<boolean> {
  const tempDir = mkdtempSync(path.join(tmpdir(), "threa-test-silent-probe-playwright-"))
  const stdoutPath = path.join(tempDir, "probe.stdout")
  const stderrPath = path.join(tempDir, "probe.stderr")
  try {
    const command = ["bunx", "playwright", "test", ...config.baseOptions, ...optionArgs, ...patterns, "--reporter=json"]
    if (targets.length > 0) {
      command.push(...targets)
    }
    await runCaptured(command, config.cwd, stdoutPath, stderrPath, envVars)
    const parsed = parsePlaywrightJson(readFileSync(stdoutPath, "utf8"))
    return parsed.failed > 0
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function main(): Promise<number> {
  const mode = process.argv[2] as Mode | undefined
  if (!mode || !modeConfigs[mode]) return usage()

  const config = modeConfigs[mode]
  const extraArgs = process.argv.slice(3)
  const verboseAliases = new Set(["--verbose", "--show-all-logs", "--show-all-output"])
  const forceVerbose = extraArgs.some((arg) => verboseAliases.has(arg)) || !!process.env.CI
  const filteredArgs = extraArgs.filter((arg) => !verboseAliases.has(arg))

  if (forceVerbose) {
    const split = splitArgs(filteredArgs, config.runner)
    const patterns = split.patternArgs.length > 0 ? split.patternArgs : config.defaultPatterns

    let command: string[]
    if (config.runner === "bun") {
      command = ["bun", "test", ...config.baseOptions, ...split.optionArgs, ...patterns]
    } else if (config.runner === "vitest") {
      command = ["bunx", "vitest", "run", ...config.baseOptions, ...split.optionArgs, ...patterns]
    } else {
      command = ["bunx", "playwright", "test", ...config.baseOptions, ...split.optionArgs, ...patterns]
    }

    const exitCode = await runVerbose(command, config.cwd)
    return exitCode === 0 ? 0 : 1
  }

  const split = splitArgs(extraArgs, config.runner)

  const firstPassBlockedByRunner: Record<Runner, Set<string>> = {
    bun: new Set(["--reporter", "--reporter-outfile", "--only-failures"]),
    vitest: new Set(["--reporter", "--outputFile", "--silent"]),
    playwright: new Set(["--reporter"]),
  }
  const rerunBlockedByRunner: Record<Runner, Set<string>> = {
    bun: new Set(["--reporter", "--reporter-outfile", "--only-failures", "--test-name-pattern", "-t"]),
    vitest: new Set(["--reporter", "--outputFile", "--silent", "--testNamePattern", "-t"]),
    playwright: new Set(["--reporter"]),
  }

  const firstPassOptions = stripOptions(split.optionArgs, config.runner, firstPassBlockedByRunner[config.runner])
  const rerunOptions = stripOptions(split.optionArgs, config.runner, rerunBlockedByRunner[config.runner])
  const patterns = split.patternArgs.length > 0 ? split.patternArgs : config.defaultPatterns

  const tempDir = mkdtempSync(path.join(tmpdir(), "threa-test-silent-"))
  const stdoutPath = path.join(tempDir, "first-pass.stdout")
  const stderrPath = path.join(tempDir, "first-pass.stderr")
  const reportPath = path.join(tempDir, "first-pass.report")
  const backendLogPath = path.join(tempDir, "backend.ndjson")
  const shouldCaptureBackendLogs = config.runner === "bun" || config.runner === "playwright"
  const runEnv = shouldCaptureBackendLogs ? { ...process.env, THREA_TEST_LOG_FILE: backendLogPath } : process.env

  const cleanup = () => rmSync(tempDir, { recursive: true, force: true })

  try {
    let firstPassCommand: string[]
    if (config.runner === "bun") {
      firstPassCommand = [
        "bun",
        "test",
        ...config.baseOptions,
        ...firstPassOptions,
        ...patterns,
        "--only-failures",
        "--reporter=junit",
        "--reporter-outfile",
        reportPath,
      ]
    } else if (config.runner === "vitest") {
      firstPassCommand = [
        "bunx",
        "vitest",
        "run",
        ...config.baseOptions,
        ...firstPassOptions,
        ...patterns,
        "--silent=passed-only",
        "--reporter=json",
        "--outputFile",
        reportPath,
      ]
    } else {
      firstPassCommand = [
        "bunx",
        "playwright",
        "test",
        ...config.baseOptions,
        ...firstPassOptions,
        ...patterns,
        "--reporter=json",
      ]
    }

    await runCaptured(firstPassCommand, config.cwd, stdoutPath, stderrPath, runEnv)

    let parsed: ParseResult
    if (config.runner === "bun") {
      parsed = parseBunJunit(readFileSync(reportPath, "utf8"))
    } else if (config.runner === "vitest") {
      parsed = parseVitestJson(readFileSync(reportPath, "utf8"))
    } else {
      parsed = parsePlaywrightJson(readFileSync(stdoutPath, "utf8"))
    }

    summarize(parsed)

    if (parsed.failed === 0) {
      cleanup()
      return 0
    }

    console.log(
      `Rechecking ${Math.max(parsed.failures.length, parsed.failed)} failing tests and replaying only persistent failures verbosely...`
    )

    let rerunExit = 1
    if (config.runner === "bun") {
      rerunExit = await rerunBunFailures(
        config,
        rerunOptions,
        patterns,
        parsed.failures,
        readFileSync(stderrPath, "utf8"),
        runEnv
      )
    } else if (config.runner === "vitest") {
      rerunExit = await rerunVitestFailures(config, rerunOptions, patterns, parsed.failures, runEnv)
    } else {
      rerunExit = await rerunPlaywrightFailures(
        config,
        rerunOptions,
        patterns,
        parsed.failures,
        parsed.infraErrors,
        runEnv
      )
    }

    printFailureArtifacts(tempDir, shouldCaptureBackendLogs ? backendLogPath : undefined)
    if (rerunExit === 0) return 1
    return 1
  } catch (error) {
    console.error("Silent test runner failed:")
    console.error(error)
    try {
      const capturedErr = readFileSync(stderrPath, "utf8")
      if (capturedErr.trim().length > 0) {
        console.error("\n--- Captured stderr ---")
        console.error(capturedErr)
      }
      const capturedOut = readFileSync(stdoutPath, "utf8")
      if (capturedOut.trim().length > 0) {
        console.error("\n--- Captured stdout ---")
        console.error(capturedOut)
      }
    } catch {
      // Ignore reading errors during fallback printing.
    }
    printFailureArtifacts(tempDir, shouldCaptureBackendLogs ? backendLogPath : undefined)
    return 1
  }
}

void main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error("Silent test runner failed:")
    console.error(error)
    process.exitCode = 1
  })
