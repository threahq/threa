import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"

const services = ["backend", "control-plane", "db-read-proxy", "enclave"] as const
type Service = (typeof services)[number]

const timeoutMs = 120_000
const dockerTimeoutMs = 30_000
const pullTimeoutMs = 120_000
const pullAttempts = 3
const pollMs = 1_000
const logLimit = 16_000
const ownedContainers: string[] = []
const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`
const network = `threa-image-smoke-${suffix}`
let receivedSignal: "SIGINT" | "SIGTERM" | undefined

interface DockerOptions {
  capture?: boolean
  allowFailure?: boolean
  timeout?: number
  ignoreInterruption?: boolean
  captureTailBytes?: number
}

function throwIfInterrupted() {
  if (receivedSignal) throw new Error(`interrupted by ${receivedSignal}`)
}

function usage(): never {
  console.error(`Usage: bun scripts/smoke-production-image.ts <${services.join("|")}> <local-image-tag>`)
  process.exit(2)
}

const [serviceArg, image] = process.argv.slice(2)
if (!services.includes(serviceArg as Service) || !image || process.argv.length !== 4) usage()
const service = serviceArg as Service

async function docker(args: string[], options: DockerOptions = {}) {
  if (!options.ignoreInterruption) throwIfInterrupted()
  const child = spawn("docker", args, {
    env: { PATH: process.env.PATH ?? "" },
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  })
  let stdout = ""
  let stderr = ""
  let capturedTail = Buffer.alloc(0)
  let timedOut = false
  const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
    if (options.captureTailBytes !== undefined) {
      capturedTail = Buffer.concat([capturedTail, chunk]).subarray(-options.captureTailBytes)
    } else if (stream === "stdout") {
      stdout += String(chunk)
    } else {
      stderr += String(chunk)
    }
  }
  child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk))
  child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk))
  const commandTimeout = options.timeout ?? dockerTimeoutMs
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, commandTimeout)
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (status) => resolve(status ?? 1))
  }).finally(() => clearTimeout(timer))
  if (timedOut) throw new Error(`docker ${args[0]} timed out after ${commandTimeout / 1000}s`)
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`docker ${args[0]} failed (${code})${stderr ? `: ${stderr.trim()}` : ""}`)
  }
  if (options.captureTailBytes !== undefined) stdout = capturedTail.toString()
  if (!options.ignoreInterruption) throwIfInterrupted()
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

async function removeOwnedResource(label: string, args: string[], missingMessage: string) {
  try {
    const result = await docker(args, {
      capture: true,
      allowFailure: true,
      ignoreInterruption: true,
    })

    if (result.code === 0 || result.stderr.includes(missingMessage)) return false

    console.error(`[${service}] cleanup failed for ${label}: ${result.stderr}`)
    return true
  } catch (error) {
    console.error(`[${service}] cleanup failed for ${label}: ${error instanceof Error ? error.message : String(error)}`)
    return true
  }
}

async function removeOwnedResources() {
  let failed = false

  for (const name of [...ownedContainers].reverse()) {
    if (await removeOwnedResource(name, ["rm", "-f", name], "No such container")) failed = true
  }

  if (await removeOwnedResource(network, ["network", "rm", network], "not found")) failed = true
  if (failed && !receivedSignal) process.exitCode = 1
}

async function pull(imageName: string) {
  for (let attempt = 1; attempt <= pullAttempts; attempt++) {
    throwIfInterrupted()
    console.log(`[${service}] pulling dependency ${imageName} (attempt ${attempt}/${pullAttempts})`)
    try {
      await docker(["pull", imageName], { timeout: pullTimeoutMs })
      return
    } catch (error) {
      throwIfInterrupted()
      if (attempt === pullAttempts) throw error
      const delayMs = attempt * 1_000
      console.error(
        `[${service}] dependency pull failed; retrying in ${delayMs / 1000}s: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      await Bun.sleep(delayMs)
    }
  }
}

async function runOwned(name: string, args: string[]) {
  ownedContainers.push(name)
  await docker(["run", "-d", "--name", name, "--network", network, ...args])
}

async function waitFor(label: string, check: () => Promise<boolean>, container?: string) {
  const deadline = Date.now() + timeoutMs
  let lastError = "not ready"
  while (Date.now() < deadline) {
    throwIfInterrupted()
    if (container) {
      const state = await docker(["inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", container], {
        capture: true,
        allowFailure: true,
      })
      if (state.code !== 0 || !state.stdout.startsWith("true ")) {
        throw new Error(`${label}: container exited early (${state.stdout || state.stderr})`)
      }
    }
    try {
      if (await check()) return
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(pollMs)
  }
  throw new Error(`${label}: timed out after ${timeoutMs / 1000}s (${lastError})`)
}

const dependencySpecs = {
  postgres: { image: "pgvector/pgvector:pg17", start: startPostgres },
  seaweed: { image: "chrislusf/seaweedfs:4.47", start: startSeaweed },
} as const
type Dependency = keyof typeof dependencySpecs

async function startPostgres() {
  const name = `threa-smoke-postgres-${suffix}`
  await runOwned(name, [
    "--network-alias",
    "postgres",
    "-e",
    "POSTGRES_USER=threa",
    "-e",
    "POSTGRES_PASSWORD=synthetic-password",
    "-e",
    "POSTGRES_DB=threa",
    dependencySpecs.postgres.image,
  ])
  await waitFor(
    "postgres readiness",
    async () => {
      const result = await docker(["exec", name, "pg_isready", "-U", "threa", "-d", "threa"], {
        capture: true,
        allowFailure: true,
      })
      return result.code === 0
    },
    name
  )
}

async function startSeaweed() {
  const name = `threa-smoke-seaweed-${suffix}`
  await runOwned(name, [
    "--network-alias",
    "seaweedfs",
    dependencySpecs.seaweed.image,
    "server",
    "-s3",
    "-dir=/data",
    "-ip=seaweedfs",
    "-s3.port=8333",
  ])
  await waitFor(
    "SeaweedFS S3 readiness",
    async () => {
      const result = await docker(["exec", name, "wget", "-q", "-O", "-", "http://127.0.0.1:8333/"], {
        capture: true,
        allowFailure: true,
      })
      return result.code === 0
    },
    name
  )
}

const commonEnv = [
  "NODE_ENV=production",
  "DATABASE_URL=postgresql://threa:synthetic-password@postgres:5432/threa",
  "CORS_ALLOWED_ORIGINS=https://synthetic.invalid",
  "WORKOS_API_KEY=sk_test_synthetic",
  "WORKOS_CLIENT_ID=client_synthetic",
  "WORKOS_REDIRECT_URI=https://synthetic.invalid/api/auth/callback",
  "WORKOS_COOKIE_PASSWORD=synthetic-cookie-password-at-least-32-characters",
  "SESSION_COOKIE_NAME=wos_session",
]

interface ServiceConfig {
  dependencies: readonly Dependency[]
  env: string[]
  health: {
    port: number
    path: string
    runtime: "bun" | "node"
    expectedJson: Record<string, unknown>
  }
  verifyPublicKey?: boolean
}

const configs: Record<Service, ServiceConfig> = {
  backend: {
    dependencies: ["postgres", "seaweed"],
    health: { port: 3001, path: "/health", runtime: "bun", expectedJson: { status: "ok" } },
    env: [
      ...commonEnv,
      "OPENROUTER_API_KEY=sk-or-synthetic",
      "S3_REGION=us-east-1",
      "S3_BUCKET=synthetic-bucket",
      "S3_ENDPOINT=http://seaweedfs:8333",
      "S3_ACCESS_KEY_ID=synthetic-access-key",
      "S3_SECRET_ACCESS_KEY=synthetic-secret-key",
      "ATTACHMENT_MALWARE_SCAN_ENABLED=false",
      "DATABASE_WARM_POOL_COUNT=1",
    ],
  },
  "control-plane": {
    dependencies: ["postgres"],
    health: { port: 3003, path: "/readyz", runtime: "bun", expectedJson: { status: "ok" } },
    env: [
      ...commonEnv,
      "INTERNAL_API_KEY=synthetic-internal-api-key",
      "CLOUDFLARE_KV_ACCOUNT_ID=synthetic-account",
      "CLOUDFLARE_KV_NAMESPACE_ID=synthetic-namespace",
      "CLOUDFLARE_KV_API_TOKEN=synthetic-token",
    ],
  },
  "db-read-proxy": {
    dependencies: ["postgres"],
    health: { port: 3010, path: "/readyz", runtime: "bun", expectedJson: { ok: true } },
    env: [
      "NODE_ENV=production",
      "DATABASE_URL=postgresql://threa:synthetic-password@postgres:5432/threa",
      "DB_READ_PROXY_SECRET=synthetic-proxy-secret-at-least-32-characters",
    ],
  },
  enclave: {
    dependencies: [],
    health: { port: 3011, path: "/healthz", runtime: "node", expectedJson: { status: "ok" } },
    verifyPublicKey: true,
    env: [
      "NODE_ENV=production",
      "ENCLAVE_INTERNAL_API_KEY=synthetic-enclave-internal-key",
      "BACKEND_BASE_URL=http://unreachable-backend:3001",
      "OPENROUTER_API_KEY=sk-or-synthetic",
    ],
  },
}

async function probe(container: string, health: ServiceConfig["health"]) {
  const program = `
const response = await fetch("http://127.0.0.1:${health.port}${health.path}")
const text = await response.text()

if (!response.ok) {
  throw new Error(response.status + " " + text)
}

console.log(text)
`
  const args =
    health.runtime === "bun"
      ? ["exec", container, "bun", "-e", program]
      : ["exec", container, "node", "--input-type=module", "-e", program]
  const result = await docker(args, { capture: true, allowFailure: true })
  if (result.code !== 0) throw new Error(result.stderr || `probe exited ${result.code}`)
  const body = JSON.parse(result.stdout)
  if (JSON.stringify(body) !== JSON.stringify(health.expectedJson)) {
    throw new Error(`unexpected JSON: ${result.stdout}`)
  }
  return result.stdout
}

async function main() {
  console.log(`[${service}] smoke testing ${image} on isolated network ${network}`)
  await docker(["image", "inspect", image], { capture: true })
  const config = configs[service]
  for (const dependency of config.dependencies) await pull(dependencySpecs[dependency].image)
  await docker(["network", "create", "--internal", network])
  for (const dependency of config.dependencies) await dependencySpecs[dependency].start()

  const app = `threa-smoke-${service}-${suffix}`
  await runOwned(app, ["--network-alias", service, ...config.env.flatMap((value) => ["-e", value]), image])
  let body = ""
  await waitFor(
    `${service} ${config.health.path}`,
    async () => {
      body = await probe(app, config.health)
      return true
    },
    app
  )
  console.log(`[${service}] ${config.health.path} ${body}`)

  if (config.verifyPublicKey) {
    const program = `
const response = await fetch("http://127.0.0.1:3011/pubkey")
const body = await response.json()
const publicKeyLength = Buffer.from(body.publicKey, "base64url").length

if (
  !response.ok ||
  typeof body.instanceId !== "string" ||
  typeof body.keyId !== "string" ||
  publicKeyLength !== 32
) {
  throw new Error(JSON.stringify(body))
}

console.log(JSON.stringify(body))
`
    const result = await docker(["exec", app, "node", "--input-type=module", "-e", program], { capture: true })
    console.log(`[${service}] /pubkey ${result.stdout}`)
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (receivedSignal) return
    receivedSignal = signal
    process.exitCode = 128 + (signal === "SIGINT" ? 2 : 15)
    console.error(`[${service}] received ${signal}; cleanup will start after the active Docker command`)
  })
}

try {
  await main()
} catch (error) {
  console.error(`[${service}] smoke failed: ${error instanceof Error ? error.message : String(error)}`)
  let remainingLogBytes = logLimit
  for (const name of [...ownedContainers].reverse()) {
    try {
      const logs = await docker(["logs", "--tail", "200", name], {
        capture: true,
        allowFailure: true,
        ignoreInterruption: true,
        captureTailBytes: remainingLogBytes,
      })
      if (logs.stdout) {
        console.error(`[${service}] logs ${name}:\n${logs.stdout}`)
        remainingLogBytes = Math.max(0, remainingLogBytes - Buffer.byteLength(logs.stdout))
      }
    } catch (logError) {
      console.error(
        `[${service}] failed to collect logs for ${name}: ${
          logError instanceof Error ? logError.message : String(logError)
        }`
      )
    }
    if (remainingLogBytes === 0) break
  }
  if (!receivedSignal) process.exitCode = 1
} finally {
  await removeOwnedResources()
}
