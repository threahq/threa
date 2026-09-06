import { addLogDestination } from "../logger"
import type { PostHogConfig } from "./config"

const MAX_ATTRIBUTE_BYTES = 2048
const MAX_BODY_BYTES = 8192
const STDERR_RATE_LIMIT_MS = 60_000
const DEFAULT_MAX_BATCH = 100
const DEFAULT_MAX_QUEUE = 1000
const DEFAULT_FLUSH_INTERVAL_MS = 2000
const RETRY_DELAY_MS = 500
const REQUEST_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 5000

// `level`, `time` and `msg` become OTLP log-record fields; `pid` and `hostname`
// are dropped — the resource already carries service.name and cloud.region.
const PINO_RECORD_FIELDS = new Set(["level", "time", "msg", "pid", "hostname"])

// Descending by pino level: pinoLevelToSeverity walks down and clamps to the
// nearest lower band, so a level between two entries maps to the lower one.
const SEVERITY_BANDS: ReadonlyArray<{ level: number; number: number; text: string }> = [
  { level: 60, number: 21, text: "FATAL" },
  { level: 50, number: 17, text: "ERROR" },
  { level: 40, number: 13, text: "WARN" },
  { level: 30, number: 9, text: "INFO" },
  { level: 20, number: 5, text: "DEBUG" },
  { level: 10, number: 1, text: "TRACE" },
]

export function pinoLevelToSeverity(level: number): { number: number; text: string } {
  for (const band of SEVERITY_BANDS) {
    if (level >= band.level) return { number: band.number, text: band.text }
  }
  const lowest = SEVERITY_BANDS[SEVERITY_BANDS.length - 1]!
  return { number: lowest.number, text: lowest.text }
}

export type OtlpAttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean }

export interface OtlpAttribute {
  key: string
  value: OtlpAttributeValue
}

export function toOtlpAttributes(record: Record<string, unknown>): OtlpAttribute[] {
  const attributes: OtlpAttribute[] = []
  for (const [key, value] of Object.entries(record)) {
    if (PINO_RECORD_FIELDS.has(key)) continue
    attributes.push({ key, value: toOtlpAttributeValue(value) })
  }
  return attributes
}

function toOtlpAttributeValue(value: unknown): OtlpAttributeValue {
  if (typeof value === "string") return { stringValue: truncateUtf8(value, MAX_ATTRIBUTE_BYTES) }
  if (typeof value === "boolean") return { boolValue: value }
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  }
  const json = JSON.stringify(value)
  return { stringValue: truncateUtf8(json ?? String(value), MAX_ATTRIBUTE_BYTES) }
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf-8")
  if (encoded.byteLength <= maxBytes) return text
  return `${encoded.subarray(0, maxBytes).toString("utf-8")}…`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

interface OtlpLogRecord {
  timeUnixNano: string
  severityNumber: number
  severityText: string
  body: { stringValue: string }
  attributes: OtlpAttribute[]
}

export interface PostHogLogShipperStats {
  queued: number
  droppedForOverflow: number
  droppedForParse: number
  droppedBatches: number
}

export interface PostHogLogShipperParams {
  config: PostHogConfig
  service: string
  region: string | null
  environment: string
  fetchImpl?: typeof fetch
  maxBatch?: number
  maxQueue?: number
  flushIntervalMs?: number
}

/**
 * Ships pino log lines to PostHog over OTLP/HTTP. Never logs through pino:
 * every pino line flows through here, so a pino call from inside would recurse.
 * Diagnostics go to `process.stderr`, rate-limited to one line a minute.
 */
export class PostHogLogShipper {
  private readonly endpoint: string
  private readonly service: string
  private readonly region: string | null
  private readonly environment: string
  private readonly projectToken: string
  private readonly fetchImpl: typeof fetch
  private readonly maxBatch: number
  private readonly maxQueue: number
  private readonly timer: ReturnType<typeof setInterval>

  private queue: OtlpLogRecord[] = []
  private closed = false
  private droppedForOverflow = 0
  private droppedForParse = 0
  private droppedBatches = 0
  private lastStderrWriteMs = 0

  constructor(params: PostHogLogShipperParams) {
    this.endpoint = `${params.config.host}/i/v1/logs`
    this.projectToken = params.config.projectToken
    this.service = params.service
    this.region = params.region
    this.environment = params.environment
    this.fetchImpl = params.fetchImpl ?? fetch
    this.maxBatch = params.maxBatch ?? DEFAULT_MAX_BATCH
    this.maxQueue = params.maxQueue ?? DEFAULT_MAX_QUEUE

    const flushIntervalMs = params.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS
    this.timer = setInterval(() => {
      void this.flush()
    }, flushIntervalMs)
    this.timer.unref?.()
  }

  write(line: string): void {
    // pino's multistream has no remove, so this destination outlives shutdown.
    // Without the guard a shut-down shipper would queue every later log line.
    if (this.closed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.droppedForParse++
      this.reportStderr("PostHogLogShipper: dropped an unparseable log line")
      return
    }
    if (typeof parsed !== "object" || parsed === null) {
      this.droppedForParse++
      this.reportStderr("PostHogLogShipper: dropped a non-object log line")
      return
    }

    if (this.queue.length >= this.maxQueue) {
      this.queue.shift()
      this.droppedForOverflow++
      this.reportStderr("PostHogLogShipper: queue overflow, dropped the oldest log line")
    }
    this.queue.push(this.toLogRecord(parsed as Record<string, unknown>))

    if (this.queue.length >= this.maxBatch) {
      void this.flush()
    }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return
    const batch = this.queue.splice(0, this.maxBatch)
    const ok = await this.postWithRetry(this.toRequestBody(batch))
    if (!ok) {
      this.droppedBatches++
      this.reportStderr(`PostHogLogShipper: dropped a batch of ${batch.length} log lines after retry`)
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS
    while (this.queue.length > 0 && Date.now() < deadline) {
      await Promise.race([this.flush(), sleep(deadline - Date.now())])
    }
    this.reportStderr(
      `PostHogLogShipper: shutdown — queued=${this.queue.length}, droppedForOverflow=${this.droppedForOverflow}, droppedForParse=${this.droppedForParse}, droppedBatches=${this.droppedBatches}`,
      { force: true }
    )
  }

  stats(): PostHogLogShipperStats {
    return {
      queued: this.queue.length,
      droppedForOverflow: this.droppedForOverflow,
      droppedForParse: this.droppedForParse,
      droppedBatches: this.droppedBatches,
    }
  }

  private toLogRecord(parsed: Record<string, unknown>): OtlpLogRecord {
    const level = typeof parsed.level === "number" ? parsed.level : 30
    const severity = pinoLevelToSeverity(level)
    const timeMs = typeof parsed.time === "number" ? parsed.time : Date.now()
    const msg = typeof parsed.msg === "string" ? parsed.msg : ""
    return {
      timeUnixNano: String(BigInt(Math.trunc(timeMs)) * 1_000_000n),
      severityNumber: severity.number,
      severityText: severity.text,
      body: { stringValue: truncateUtf8(msg, MAX_BODY_BYTES) },
      attributes: toOtlpAttributes(parsed),
    }
  }

  private toRequestBody(records: OtlpLogRecord[]): unknown {
    const resourceAttributes: OtlpAttribute[] = [
      { key: "service.name", value: { stringValue: `threa-${this.service}` } },
      { key: "deployment.environment", value: { stringValue: this.environment } },
    ]
    if (this.region !== null) {
      resourceAttributes.push({ key: "cloud.region", value: { stringValue: this.region } })
    }
    return {
      resourceLogs: [
        {
          resource: { attributes: resourceAttributes },
          scopeLogs: [{ scope: { name: "pino" }, logRecords: records }],
        },
      ],
    }
  }

  private async postWithRetry(payload: unknown): Promise<boolean> {
    if (await this.postOnce(payload)) return true
    await sleep(RETRY_DELAY_MS)
    return this.postOnce(payload)
  }

  private async postOnce(payload: unknown): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    timer.unref?.()
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.projectToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  private reportStderr(message: string, opts?: { force: boolean }): void {
    const now = Date.now()
    if (!opts?.force && now - this.lastStderrWriteMs < STDERR_RATE_LIMIT_MS) return
    this.lastStderrWriteMs = now
    process.stderr.write(`${message}\n`)
  }
}

/**
 * Start shipping this process's pino output to PostHog Logs, or return null when
 * `POSTHOG_LOGS_LEVEL` is unset. The caller owns the returned shipper's shutdown.
 */
export function attachPostHogLogShipping(params: PostHogLogShipperParams): PostHogLogShipper | null {
  if (params.config.logsLevel === null) return null
  const shipper = new PostHogLogShipper(params)
  addLogDestination({
    level: params.config.logsLevel,
    stream: { write: (line: string) => shipper.write(line) },
  })
  return shipper
}
