#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import { spawn, type ChildProcess } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import type { Readable, Writable } from "node:stream"

export type MergeMethod = "MERGE" | "SQUASH" | "REBASE"

export interface MergeStackArgs {
  pullRequest: number
  repo?: string
  method: MergeMethod
  yes: boolean
  dryRun: boolean
  json: boolean
  timeoutSeconds: number
  chromeBin?: string
  chromeProfile?: string
}

interface StackPullRequest {
  number: number
  state: "open" | "closed"
  draft: boolean
  merged_at: string | null
  head: {
    ref: string
    sha: string
  }
}

interface StackResource {
  number: number
  open: boolean
  base: {
    ref: string
  }
  pull_requests: StackPullRequest[]
}

export interface MergePlan {
  stackNumber: number
  targetPullRequest: number
  baseRef: string
  entries: StackPullRequest[]
  expectedHeads: Record<number, string>
}

interface BrowserPreflight {
  browserUser: string
  commitTitle: string
  commitMessage: string
  authorEmail?: string
  nonce: string
  entries: Array<{
    number: number
    state: string | null
    effectiveEntryStatus: string | null
  }>
}

interface BrowserRequestResult {
  status: number
  message: string
}

const usage = `Usage:
  bun .agents/skills/gh-stack/scripts/merge-stack.ts <pull-request> --yes [options]
  bun .agents/skills/gh-stack/scripts/merge-stack.ts <pull-request> --dry-run [options]

Options:
  --repo OWNER/REPO       Repository; defaults to the current gh repository
  --method METHOD         squash (default), merge, or rebase
  --yes                   Execute the irreversible merge
  --dry-run               Validate stack and browser mergeability without merging
  --timeout SECONDS       Merge completion timeout (default: 180)
  --chrome-bin PATH       Chrome executable; also GH_STACK_CHROME_BIN
  --chrome-profile PATH   Chrome profile directory; also GH_STACK_CHROME_PROFILE
  --json                  Print the result as JSON
  -h, --help              Show this help
`

export function parseArgs(argv: string[]): MergeStackArgs {
  let pullRequest: number | undefined
  let repo: string | undefined
  let method: MergeMethod = "SQUASH"
  let yes = false
  let dryRun = false
  let json = false
  let timeoutSeconds = 180
  let chromeBin: string | undefined
  let chromeProfile: string | undefined

  const takeValue = (index: number, flag: string): string => {
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`)
    }
    return value
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "-h" || arg === "--help") {
      console.log(usage)
      process.exit(0)
    }
    if (arg === "--yes") {
      yes = true
      continue
    }
    if (arg === "--dry-run") {
      dryRun = true
      continue
    }
    if (arg === "--json") {
      json = true
      continue
    }
    if (arg === "--repo") {
      repo = takeValue(index, arg)
      index += 1
      continue
    }
    if (arg === "--method") {
      const value = takeValue(index, arg).toUpperCase()
      if (value !== "MERGE" && value !== "SQUASH" && value !== "REBASE") {
        throw new Error(`unsupported merge method: ${value.toLowerCase()}`)
      }
      method = value
      index += 1
      continue
    }
    if (arg === "--timeout") {
      const value = Number(takeValue(index, arg))
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--timeout must be a positive integer")
      }
      timeoutSeconds = value
      index += 1
      continue
    }
    if (arg === "--chrome-bin") {
      chromeBin = takeValue(index, arg)
      index += 1
      continue
    }
    if (arg === "--chrome-profile") {
      chromeProfile = takeValue(index, arg)
      index += 1
      continue
    }
    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`)
    }
    if (pullRequest !== undefined) {
      throw new Error("provide exactly one pull request number")
    }
    pullRequest = Number(arg.replace(/^#/, ""))
  }

  if (!Number.isInteger(pullRequest) || pullRequest! < 1) {
    throw new Error("a positive pull request number is required")
  }
  if (yes === dryRun) {
    throw new Error("choose exactly one of --yes or --dry-run")
  }
  if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`invalid repository: ${repo}`)
  }

  return {
    pullRequest: pullRequest!,
    repo,
    method,
    yes,
    dryRun,
    json,
    timeoutSeconds,
    chromeBin,
    chromeProfile,
  }
}

export function createMergePlan(stack: StackResource, targetPullRequest: number): MergePlan {
  if (!stack.open) {
    throw new Error(`stack #${stack.number} has no open pull requests`)
  }

  const targetIndex = stack.pull_requests.findIndex((pull) => pull.number === targetPullRequest)
  if (targetIndex === -1) {
    throw new Error(`pull request #${targetPullRequest} is not in stack #${stack.number}`)
  }

  const target = stack.pull_requests[targetIndex]!
  if (target.state !== "open" || target.merged_at) {
    throw new Error(`target pull request #${targetPullRequest} is not open`)
  }

  const entries = stack.pull_requests.slice(0, targetIndex + 1).filter((pull) => pull.merged_at === null)

  const blocked = entries.find((pull) => pull.state !== "open" || pull.draft)
  if (blocked) {
    const reason = blocked.draft ? "draft" : blocked.state
    throw new Error(`pull request #${blocked.number} is ${reason}; stack cannot merge through #${targetPullRequest}`)
  }

  return {
    stackNumber: stack.number,
    targetPullRequest,
    baseRef: stack.base.ref,
    entries,
    expectedHeads: Object.fromEntries(entries.map((pull) => [pull.number, pull.head.sha])),
  }
}

export function assertExpectedHeads(plan: MergePlan, current: StackResource): void {
  if (current.number !== plan.stackNumber) {
    throw new Error(`pull request moved from stack #${plan.stackNumber} to stack #${current.number}`)
  }
  const currentPlan = createMergePlan(current, plan.targetPullRequest)
  if (currentPlan.baseRef !== plan.baseRef) {
    throw new Error(`stack base changed from ${plan.baseRef} to ${currentPlan.baseRef} during preflight`)
  }

  const expectedNumbers = plan.entries.map((entry) => entry.number)
  const currentNumbers = currentPlan.entries.map((entry) => entry.number)
  if (JSON.stringify(currentNumbers) !== JSON.stringify(expectedNumbers)) {
    throw new Error(
      `stack entries changed during preflight: expected ${expectedNumbers.join(",")}, got ${currentNumbers.join(",")}`
    )
  }

  for (const entry of currentPlan.entries) {
    if (entry.head.sha !== plan.expectedHeads[entry.number]) {
      throw new Error(`pull request #${entry.number} head changed during preflight`)
    }
  }
}

async function command(args: string[], timeoutMs = 30_000): Promise<string> {
  const subprocess = Bun.spawn(args, {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const completion = Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])
  const result = await Promise.race([completion, Bun.sleep(timeoutMs).then(() => null)])
  if (!result) {
    subprocess.kill("SIGTERM")
    await Promise.race([subprocess.exited, Bun.sleep(500)])
    if (subprocess.exitCode === null) subprocess.kill("SIGKILL")
    await Promise.race([subprocess.exited, Bun.sleep(1_500)])
    throw new Error(`${args.join(" ")} timed out after ${timeoutMs}ms`)
  }
  const [stdout, stderr, exitCode] = result
  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`)
  }
  return stdout.trim()
}

async function ghJson<T>(path: string, timeoutMs?: number): Promise<T> {
  return JSON.parse(await command(["gh", "api", "-X", "GET", path], timeoutMs)) as T
}

async function resolveRepo(repo?: string): Promise<string> {
  if (repo) return repo
  const result = JSON.parse(await command(["gh", "repo", "view", "--json", "nameWithOwner"])) as {
    nameWithOwner: string
  }
  return result.nameWithOwner
}

async function loadStack(repo: string, pullRequest: number): Promise<StackResource> {
  const stacks = await ghJson<StackResource[]>(`repos/${repo}/stacks?pull_request=${pullRequest}&per_page=1`)
  const stack = stacks[0]
  if (!stack) {
    throw new Error(`pull request #${pullRequest} does not belong to a GitHub stack`)
  }
  return stack
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

async function resolveChromeBinary(override?: string): Promise<string> {
  const configured = override ?? process.env.GH_STACK_CHROME_BIN
  if (configured) {
    const path = resolve(configured)
    if (!(await isExecutable(path))) throw new Error(`Chrome executable not found or not executable: ${path}`)
    return path
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    Bun.which("google-chrome"),
    Bun.which("google-chrome-stable"),
    Bun.which("chromium"),
    Bun.which("chromium-browser"),
  ].filter((path): path is string => Boolean(path))

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate
  }
  throw new Error("Google Chrome not found; pass --chrome-bin or GH_STACK_CHROME_BIN")
}

async function resolveChromeProfile(override?: string): Promise<string> {
  const configured = override ?? process.env.GH_STACK_CHROME_PROFILE
  const candidates = configured
    ? [configured]
    : [
        join(homedir(), "Library/Application Support/Google/Chrome/Default"),
        join(homedir(), ".config/google-chrome/Default"),
        join(homedir(), ".config/chromium/Default"),
      ]

  for (const candidate of candidates) {
    const path = resolve(candidate)
    const cookies = [join(path, "Cookies"), join(path, "Network/Cookies")]
    if ((await exists(path)) && (await Promise.all(cookies.map(exists))).some(Boolean)) {
      return path
    }
  }
  throw new Error("Chrome profile with cookies not found; pass --chrome-profile or GH_STACK_CHROME_PROFILE")
}

async function copyFileSnapshot(source: string, destination: string): Promise<boolean> {
  if (!(await exists(source))) return false
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await writeFile(destination, await readFile(source), { mode: 0o600 })
  return true
}

async function copySqliteSnapshot(source: string, destination: string): Promise<boolean> {
  if (!(await exists(source))) return false
  const database = new Database(source, { readonly: true })
  try {
    database.query("SELECT COUNT(*) AS count FROM sqlite_master").get()
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, database.serialize(), { mode: 0o600 })
    return true
  } finally {
    database.close()
  }
}

class CdpSession {
  private nextId = 0
  private pageSessionId?: string
  private buffer = Buffer.alloc(0)
  private closed = false
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timeout: ReturnType<typeof setTimeout>
    }
  >()

  constructor(
    private readonly input: Writable,
    private readonly output: Readable
  ) {
    output.on("data", (chunk: Buffer) => this.handleData(chunk))
    output.on("error", (error) => this.failPending(error))
    output.on("close", () => this.failPending(new Error("Chrome DevTools pipe closed")))
  }

  async attachToPage(): Promise<void> {
    const targets = await this.request<{
      targetInfos: Array<{ targetId: string; type: string }>
    }>("Target.getTargets")
    const target = targets.targetInfos.find((candidate) => candidate.type === "page")
    if (!target) throw new Error("Chrome page target did not start")
    const attached = await this.request<{ sessionId: string }>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    })
    this.pageSessionId = attached.sessionId
  }

  async request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new Error("Chrome DevTools pipe is closed")
    const id = ++this.nextId
    const response = new Promise<T>((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        rejectResponse(new Error(`Chrome DevTools timed out: ${method}`))
      }, 30_000)
      this.pending.set(id, {
        resolve: (value) => resolveResponse(value as T),
        reject: rejectResponse,
        timeout,
      })
    })
    const message = {
      id,
      method,
      params,
      ...(this.pageSessionId ? { sessionId: this.pageSessionId } : {}),
    }
    this.input.write(`${JSON.stringify(message)}\0`, (error) => {
      if (!error) return
      const waiter = this.pending.get(id)
      if (!waiter) return
      clearTimeout(waiter.timeout)
      this.pending.delete(id)
      waiter.reject(error)
    })
    return response
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.failPending(new Error("Chrome DevTools pipe closed"))
    this.input.destroy()
    this.output.destroy()
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    let boundary = this.buffer.indexOf(0)
    while (boundary !== -1) {
      const payload = this.buffer.subarray(0, boundary).toString("utf8")
      this.buffer = this.buffer.subarray(boundary + 1)
      if (payload) {
        const message = JSON.parse(payload) as {
          id?: number
          result?: unknown
          error?: { message: string }
        }
        if (message.id) {
          const waiter = this.pending.get(message.id)
          if (waiter) {
            clearTimeout(waiter.timeout)
            this.pending.delete(message.id)
            if (message.error) waiter.reject(new Error(message.error.message))
            else waiter.resolve(message.result)
          }
        }
      }
      boundary = this.buffer.indexOf(0)
    }
  }

  private failPending(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
    this.pending.clear()
  }
}

interface RuntimeEvaluation {
  result: {
    type: string
    value?: string
    description?: string
  }
  exceptionDetails?: {
    text: string
    exception?: { description?: string }
  }
}

class BrowserHarness {
  private constructor(
    private readonly cdp: CdpSession,
    private readonly closeResources: () => Promise<void>
  ) {}

  static async start(chromeBin: string, sourceProfile: string): Promise<BrowserHarness> {
    const tempRoot = await mkdtemp(join(tmpdir(), "gh-stack-merge-"))
    const tempUserData = join(tempRoot, "profile")
    const profileName = basename(sourceProfile)
    const destinationProfile = join(tempUserData, profileName)
    let chromeProcess: ChildProcess | undefined
    let cdp: CdpSession | undefined
    let cleanupPromise: Promise<void> | undefined
    let signalHandling = false

    const cleanup = (): Promise<void> => {
      cleanupPromise ??= (async () => {
        const errors: Error[] = []
        try {
          cdp?.close()
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)))
        }
        try {
          if (chromeProcess) await stopChrome(chromeProcess, tempUserData)
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)))
        }
        try {
          await removeTempRoot(tempRoot)
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error(String(error)))
        } finally {
          process.off("SIGINT", onSigint)
          process.off("SIGTERM", onSigterm)
        }
        if (errors.length) throw new AggregateError(errors, errors.map((error) => error.message).join("; "))
      })()
      return cleanupPromise
    }
    const closeForSignal = (exitCode: number) => {
      if (signalHandling) return
      signalHandling = true
      void cleanup().then(
        () => process.exit(exitCode),
        (error) => {
          console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
          process.exit(exitCode)
        }
      )
    }
    const onSigint = () => closeForSignal(130)
    const onSigterm = () => closeForSignal(143)
    process.once("SIGINT", onSigint)
    process.once("SIGTERM", onSigterm)

    try {
      await chmod(tempRoot, 0o700)
      await mkdir(destinationProfile, { recursive: true, mode: 0o700 })
      const sourceUserData = dirname(sourceProfile)
      const localState = join(sourceUserData, "Local State")
      if (!(await copyFileSnapshot(localState, join(tempUserData, "Local State")))) {
        throw new Error(`Chrome Local State not found: ${localState}`)
      }

      const cookieLocations = ["Cookies", "Network/Cookies"]
      let copiedCookies = false
      for (const location of cookieLocations) {
        const source = join(sourceProfile, location)
        const destination = join(destinationProfile, location)
        if (await copySqliteSnapshot(source, destination)) {
          copiedCookies = true
          break
        }
      }
      if (!copiedCookies) throw new Error(`Chrome cookies not found in ${sourceProfile}`)

      chromeProcess = spawn(
        chromeBin,
        [
          "--headless=new",
          "--disable-gpu",
          "--disable-sync",
          "--disable-extensions",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${tempUserData}`,
          `--profile-directory=${profileName}`,
          "--remote-debugging-pipe",
          "about:blank",
        ],
        { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
      )
      const input = chromeProcess.stdio[3]
      const output = chromeProcess.stdio[4]
      if (!input || !output) throw new Error("Chrome DevTools pipes were not created")
      cdp = new CdpSession(input as Writable, output as Readable)
      const processError = new Promise<never>((_, reject) => chromeProcess!.once("error", reject))
      await Promise.race([cdp.attachToPage(), processError])
      await cdp.request("Page.enable")
      return new BrowserHarness(cdp, cleanup)
    } catch (error) {
      const setupError = error instanceof Error ? error : new Error(String(error))
      try {
        await cleanup()
      } catch (cleanupError) {
        const cleanupFailure = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
        throw new AggregateError(
          [setupError, cleanupFailure],
          `${setupError.message}; cleanup also failed: ${cleanupFailure.message}`
        )
      }
      throw setupError
    }
  }

  async navigate(url: string, expectedPath: string): Promise<void> {
    await this.cdp.request("Page.navigate", { url })
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const evaluation = await this.cdp.request<RuntimeEvaluation>("Runtime.evaluate", {
        expression: "JSON.stringify({ready:document.readyState,path:location.pathname})",
        returnByValue: true,
      })
      const value = evaluation.result.value
      if (value) {
        const state = JSON.parse(value) as { ready: string; path: string }
        if (state.ready === "complete" && state.path === expectedPath) return
      }
      await Bun.sleep(100)
    }
    throw new Error(`GitHub page did not load: ${expectedPath}`)
  }

  async preflight(repo: string, plan: MergePlan, method: MergeMethod): Promise<BrowserPreflight> {
    const config = JSON.stringify({
      repo,
      targetPullRequest: plan.targetPullRequest,
      pullRequests: plan.entries.map((entry) => entry.number),
      method,
    })
    const expression = `(async () => {
      const config = ${config}
      let nonce = document.querySelector('meta[name="fetch-nonce"]')?.content || ''
      const browserUser = document.querySelector('meta[name="user-login"]')?.content || ''
      if (!browserUser) return JSON.stringify({ error: 'Chrome GitHub session is not authenticated' })
      const headers = () => ({
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'GitHub-Verified-Fetch': 'true',
        'GitHub-Is-React': 'true',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Fetch-Nonce': nonce,
      })
      const getJson = async (path) => {
        const response = await fetch(path, { headers: headers() })
        nonce = response.headers.get('X-Fetch-Nonce') || nonce
        const text = await response.text()
        let body
        try { body = JSON.parse(text) } catch { body = { error: text.slice(0, 300) } }
        if (!response.ok) return { error: body.error || ('HTTP ' + response.status), status: response.status }
        return { body, status: response.status }
      }
      const prefix = '/' + config.repo + '/pull/'
      const query = '?merge_method=' + config.method + '&bypass_requirements=false'
      const mergeBox = await getJson(prefix + config.targetPullRequest + '/page_data/merge_box' + query)
      if (mergeBox.error) return JSON.stringify({ error: 'Merge box: ' + mergeBox.error })
      if (mergeBox.body?.pullRequest?.state !== 'OPEN') {
        return JSON.stringify({ error: 'Target pull request is not open in the browser session' })
      }
      const requirements = mergeBox.body?.mergeRequirements || mergeBox.body?.merge_requirements || {}
      if (requirements.state !== 'MERGEABLE') {
        return JSON.stringify({ error: 'Target merge requirements: ' + (requirements.state || 'unknown') })
      }
      const entries = []
      for (const number of config.pullRequests) {
        const result = await getJson(prefix + number + '/page_data/stack_mergeability' + query)
        if (result.error) return JSON.stringify({ error: 'PR #' + number + ': ' + result.error })
        const state = result.body?.state || null
        const effectiveEntryStatus = result.body?.effectiveEntryStatus || null
        entries.push({ number, state, effectiveEntryStatus })
        if (state !== 'MERGEABLE' || effectiveEntryStatus !== 'READY') {
          return JSON.stringify({
            error: 'PR #' + number + ' is not ready: ' + state + '/' + effectiveEntryStatus,
            entries,
          })
        }
      }
      const possibleEmails = requirements.possibleCommitAuthorEmails || requirements.possible_commit_author_emails || []
      const defaultEmail = requirements.defaultCommitAuthorEmail || requirements.default_commit_author_email
      return JSON.stringify({
        browserUser,
        commitTitle: requirements.commitMessageHeadline || requirements.commit_message_headline || '',
        commitMessage: requirements.commitMessageBody || requirements.commit_message_body || '',
        ...(possibleEmails.length && defaultEmail ? { authorEmail: defaultEmail } : {}),
        nonce,
        entries,
      })
    })()`
    return this.evaluateJson<BrowserPreflight>(expression)
  }

  async enqueue(
    repo: string,
    plan: MergePlan,
    method: MergeMethod,
    preflight: BrowserPreflight
  ): Promise<BrowserRequestResult> {
    const config = JSON.stringify({
      path: `/${repo}/pull/${plan.targetPullRequest}/page_data/enqueue_stack`,
      method,
      nonce: preflight.nonce,
      commitTitle: preflight.commitTitle,
      commitMessage: preflight.commitMessage,
      authorEmail: preflight.authorEmail,
    })
    const expression = `(async () => {
      const config = ${config}
      const body = {
        ...(config.authorEmail ? { authorEmail: config.authorEmail } : {}),
        commitTitle: config.commitTitle,
        commitMessage: config.commitMessage,
        mergeMethod: config.method,
      }
      const response = await fetch(config.path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'GitHub-Verified-Fetch': 'true',
          'GitHub-Is-React': 'true',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Fetch-Nonce': config.nonce,
        },
        body: JSON.stringify(body),
      })
      const text = await response.text()
      let parsed
      try { parsed = JSON.parse(text) } catch { parsed = {} }
      return JSON.stringify({
        status: response.status,
        message: parsed.message || parsed.error || text.slice(0, 300),
      })
    })()`
    return this.evaluateJson<BrowserRequestResult>(expression)
  }

  private async evaluateJson<T>(expression: string): Promise<T> {
    const evaluation = await this.cdp.request<RuntimeEvaluation>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (evaluation.exceptionDetails) {
      throw new Error(evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text)
    }
    const value = evaluation.result.value
    if (!value) throw new Error(evaluation.result.description ?? "browser returned no result")
    const parsed = JSON.parse(value) as T & { error?: string }
    if (parsed.error) throw new Error(parsed.error)
    return parsed
  }

  close(): Promise<void> {
    return this.closeResources()
  }
}

async function runUtility(args: string[], timeoutMs = 5_000): Promise<number | null> {
  const process = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" })
  const result = await Promise.race([process.exited, Bun.sleep(timeoutMs).then(() => null)])
  if (result !== null) return result
  process.kill("SIGKILL")
  await Promise.race([process.exited, Bun.sleep(500)])
  return null
}

async function stopChrome(process: ChildProcess, tempUserData: string): Promise<void> {
  if (process.exitCode === null) {
    try {
      process.kill("SIGTERM")
    } catch {
      // The process may have exited between the exitCode check and kill.
    }
    await Promise.race([
      new Promise<void>((resolveExit) => process.once("exit", () => resolveExit())),
      Bun.sleep(2_000),
    ])
  }
  if (process.exitCode === null) {
    try {
      process.kill("SIGKILL")
    } catch {
      // The process may have exited between the exitCode check and kill.
    }
  }

  await runUtility(["pkill", "-TERM", "-f", tempUserData])
  await Bun.sleep(200)
  await runUtility(["pkill", "-KILL", "-f", tempUserData])
  await Promise.race([
    new Promise<void>((resolveExit) => {
      if (process.exitCode !== null) resolveExit()
      else process.once("exit", () => resolveExit())
    }),
    Bun.sleep(2_000),
  ])

  const matchingProcesses = await runUtility(["pgrep", "-f", tempUserData])
  if (process.exitCode === null || matchingProcesses === 0 || matchingProcesses === null) {
    throw new Error("failed to terminate isolated Chrome")
  }
}

async function removeTempRoot(tempRoot: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await chmod(tempRoot, 0o700)
      await rm(tempRoot, { recursive: true, force: true })
      return
    } catch {
      await Bun.sleep(200)
    }
  }
  throw new Error(`failed to remove temporary Chrome profile: ${tempRoot}`)
}

async function waitForMerge(repo: string, plan: MergePlan, timeoutSeconds: number): Promise<StackResource> {
  const deadline = Date.now() + timeoutSeconds * 1_000
  while (Date.now() < deadline) {
    const remaining = Math.max(1_000, Math.min(30_000, deadline - Date.now()))
    const stack = await ghJson<StackResource>(`repos/${repo}/stacks/${plan.stackNumber}`, remaining)
    const selected = plan.entries.map((entry) => stack.pull_requests.find((pull) => pull.number === entry.number))
    if (selected.every((entry) => entry?.merged_at)) {
      const unexpectedHead = selected.find((entry) => entry && entry.head.sha !== plan.expectedHeads[entry.number])
      if (unexpectedHead) {
        throw new Error(
          `stack merged, but PR #${unexpectedHead.number} used unexpected head ${unexpectedHead.head.sha}`
        )
      }
      return stack
    }
    const closedWithoutMerge = selected.find((entry) => entry && entry.state === "closed" && !entry.merged_at)
    if (closedWithoutMerge) {
      throw new Error(`pull request #${closedWithoutMerge.number} closed without merging`)
    }
    await Bun.sleep(1_000)
  }
  throw new Error(
    `stack merge was accepted but did not finish within ${timeoutSeconds}s; inspect stack #${plan.stackNumber}`
  )
}

function printPlan(repo: string, plan: MergePlan, method: MergeMethod): void {
  console.error(
    `Stack #${plan.stackNumber}: merge ${plan.entries.length} pull request${plan.entries.length === 1 ? "" : "s"} through #${plan.targetPullRequest} into ${plan.baseRef} (${method.toLowerCase()})`
  )
  for (const entry of plan.entries) {
    console.error(`  #${entry.number} ${entry.head.ref} @ ${entry.head.sha.slice(0, 8)}`)
  }
  console.error(`  https://github.com/${repo}/pull/${plan.targetPullRequest}`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const repo = await resolveRepo(args.repo)
  const initialStack = await loadStack(repo, args.pullRequest)
  const plan = createMergePlan(initialStack, args.pullRequest)
  printPlan(repo, plan, args.method)

  const [chromeBin, chromeProfile] = await Promise.all([
    resolveChromeBinary(args.chromeBin),
    resolveChromeProfile(args.chromeProfile),
  ])
  const browser = await BrowserHarness.start(chromeBin, chromeProfile)
  let operationError: Error | undefined

  try {
    const pullPath = `/${repo}/pull/${plan.targetPullRequest}`
    await browser.navigate(`https://github.com${pullPath}`, pullPath)
    const preflight = await browser.preflight(repo, plan, args.method)
    console.error(`Browser session: ${preflight.browserUser}; all selected entries READY`)
    const latestStack = await loadStack(repo, args.pullRequest)
    assertExpectedHeads(plan, latestStack)

    if (args.dryRun) {
      const result = {
        dryRun: true,
        repo,
        stackNumber: plan.stackNumber,
        targetPullRequest: plan.targetPullRequest,
        method: args.method,
        browserUser: preflight.browserUser,
        pullRequests: plan.entries.map((entry) => entry.number),
      }
      if (args.json) console.log(JSON.stringify(result))
      else console.error("Dry run complete; no merge request sent.")
      return
    }

    console.error(
      "Heads and topology verified immediately before enqueue; GitHub exposes no expected-head CAS for this private route."
    )
    const request = await browser.enqueue(repo, plan, args.method, preflight)
    if (request.status < 200 || request.status >= 300) {
      throw new Error(`GitHub rejected stack merge (HTTP ${request.status}): ${request.message}`)
    }
    console.error(`GitHub accepted stack merge: ${request.message}`)

    const mergedStack = await waitForMerge(repo, plan, args.timeoutSeconds)
    const merged = plan.entries.map((entry) => {
      const current = mergedStack.pull_requests.find((pull) => pull.number === entry.number)!
      return { number: current.number, mergedAt: current.merged_at }
    })
    const result = {
      dryRun: false,
      repo,
      stackNumber: plan.stackNumber,
      targetPullRequest: plan.targetPullRequest,
      method: args.method,
      browserUser: preflight.browserUser,
      stackOpen: mergedStack.open,
      merged,
    }
    if (args.json) console.log(JSON.stringify(result))
    else {
      for (const entry of merged) console.error(`Merged #${entry.number} at ${entry.mergedAt}`)
      console.error(`Stack #${plan.stackNumber} merge complete.`)
    }
  } catch (error) {
    operationError = error instanceof Error ? error : new Error(String(error))
    throw error
  } finally {
    try {
      await browser.close()
    } catch (cleanupError) {
      const cleanup = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
      if (operationError) {
        throw new AggregateError(
          [operationError, cleanup],
          `${operationError.message}; cleanup also failed: ${cleanup.message}`
        )
      }
      throw cleanup
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
