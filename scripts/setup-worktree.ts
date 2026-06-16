import { $ } from "bun"
import * as path from "path"
import * as fs from "fs"
import * as os from "os"

interface ClaudeProjectConfig {
  mcpServers?: Record<string, unknown>
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  hasTrustDialogAccepted?: boolean
  [key: string]: unknown
}

interface ClaudeConfig {
  projects?: Record<string, ClaudeProjectConfig>
  [key: string]: unknown
}

interface WorktreeInfo {
  path: string
  branch: string
  isMain: boolean
}

async function getWorktrees(): Promise<WorktreeInfo[]> {
  const result = await $`git worktree list --porcelain`.text()
  const worktrees: WorktreeInfo[] = []
  let current: Partial<WorktreeInfo> = {}

  for (const line of result.split("\n")) {
    if (line.startsWith("worktree ")) {
      current.path = line.slice(9)
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7)
    } else if (line === "bare") {
      current.isMain = true
    } else if (line === "") {
      if (current.path) {
        worktrees.push({
          path: current.path,
          branch: current.branch || "unknown",
          isMain: current.isMain || false,
        })
      }
      current = {}
    }
  }

  return worktrees
}

function getMainWorktree(worktrees: WorktreeInfo[]): WorktreeInfo | undefined {
  const bare = worktrees.find((w) => w.isMain)
  if (bare) return bare

  const mainBranch = worktrees.find((w) => w.branch.endsWith("/main") || w.branch.endsWith("/master"))
  if (mainBranch) return mainBranch

  // Worktrees are conventionally named <project>.<branch>; the main has no dot in its dir name.
  const mainByNaming = worktrees.find((w) => {
    const dirName = path.basename(w.path)
    return !dirName.includes(".")
  })
  if (mainByNaming) return mainByNaming

  return worktrees[0]
}

function deriveDatabaseName(dirPath: string): string {
  const dirName = path.basename(dirPath)
  // Sanitize to a valid postgres identifier.
  const sanitized = dirName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")

  return sanitized || "threa"
}

function updateDatabaseUrl(envContent: string, newDbName: string): string {
  // Format: postgresql://user:pass@host:port/dbname
  return envContent.replace(/(DATABASE_URL=postgresql:\/\/[^/]+\/)([^?\n]+)/, `$1${newDbName}`)
}

function extractDatabaseName(envContent: string): string | null {
  // Format: postgresql://user:pass@host:port/dbname
  const match = envContent.match(/DATABASE_URL=postgresql:\/\/[^/]+\/([^?\n]+)/)
  return match ? match[1] : null
}

async function findPostgresContainer(): Promise<string | null> {
  // Find running threa-postgres container specifically (not langfuse or other postgres containers)
  const result = await $`docker ps --format '{{.Names}}' --filter 'name=threa-postgres'`.quiet().nothrow()
  const containers = result.stdout.toString().trim().split("\n").filter(Boolean)

  // Exclude test containers (e.g. threa-postgres-test-1) which also match the filter
  const mainContainers = containers.filter((name) => !name.includes("test"))

  return mainContainers[0] || null
}

async function createDatabaseIfNotExists(dbName: string): Promise<boolean> {
  console.log(`Checking if database '${dbName}' exists...`)

  const container = await findPostgresContainer()
  if (!container) {
    throw new Error("No running postgres container found. Run 'bun run db:start' from the main worktree first.")
  }

  console.log(`Using postgres container: ${container}`)

  // Connect to postgres (not a specific database) to create the new database
  const checkResult =
    await $`docker exec ${container} psql -U threa -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'"`
      .quiet()
      .nothrow()

  if (checkResult.stdout.toString().trim() === "1") {
    console.log(`Database '${dbName}' already exists`)
    return false
  }

  console.log(`Creating database '${dbName}'...`)
  await $`docker exec ${container} psql -U threa -d postgres -c "CREATE DATABASE ${dbName}"`
  console.log(`Database '${dbName}' created`)
  return true
}

async function cloneDatabase(container: string, sourceDb: string, targetDb: string): Promise<void> {
  console.log(`Cloning database '${sourceDb}' to '${targetDb}'...`)
  const lockWaitTimeout = "10s"

  // Use pg_dump --clean --if-exists so the clone works whether the target DB
  // is empty or already has schema from a previous run / migration.
  // Fail fast on lock contention to avoid an apparent "hang" with no output.
  const result =
    await $`docker exec ${container} bash -o pipefail -c "pg_dump -U threa --clean --if-exists --lock-wait-timeout=${lockWaitTimeout} ${sourceDb} | PGOPTIONS='-c lock_timeout=${lockWaitTimeout}' psql -U threa ${targetDb}"`
      .quiet()
      .nothrow()

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString()
    if (
      stderr.includes("canceling statement due to lock timeout") ||
      stderr.includes("canceling statement due to statement timeout")
    ) {
      throw new Error(
        `Database clone timed out waiting for a lock. Close other processes using '${sourceDb}' or '${targetDb}' and retry.`
      )
    }
    throw new Error(`Database clone failed: ${stderr.trim() || `exit code ${result.exitCode}`}`)
  }

  // Sync sequences with actual data (pg_dump doesn't update sequence counters)
  console.log("Syncing sequences...")
  await $`docker exec ${container} psql -U threa ${targetDb} -c "SELECT setval('outbox_id_seq', COALESCE((SELECT MAX(id) FROM outbox), 0) + 1, false)"`
    .quiet()
    .nothrow()

  // Reset outbox listener cursors to match actual outbox state.
  // The retention worker may have deleted events before the clone, leaving
  // cursors ahead of the sequence. Without this, new events get IDs below
  // the stale cursors and are permanently skipped by every listener.
  console.log("Resetting outbox listener cursors...")
  await $`docker exec ${container} psql -U threa ${targetDb} -c "UPDATE outbox_listeners SET last_processed_id = COALESCE((SELECT MAX(id) FROM outbox), 0)"`
    .quiet()
    .nothrow()

  console.log(`Database '${targetDb}' cloned from '${sourceDb}'`)
}

async function countTableRows(container: string, dbName: string, tableName: string): Promise<number> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`)
  }

  const sql = `
    SELECT CASE
      WHEN to_regclass('public.${tableName}') IS NULL THEN -1
      ELSE (SELECT count(*) FROM public.${tableName})
    END
  `
  const result = await $`docker exec ${container} psql -U threa -d ${dbName} -Atc ${sql}`.quiet().nothrow()
  if (result.exitCode !== 0) {
    throw new Error(`Could not count ${dbName}.${tableName}: ${result.stderr.toString().trim()}`)
  }

  const count = Number(result.stdout.toString().trim())
  if (!Number.isFinite(count)) {
    throw new Error(`Invalid row count for ${dbName}.${tableName}: ${result.stdout.toString().trim()}`)
  }
  return count
}

async function existingDatabaseNeedsClone(
  container: string,
  sourceDb: string,
  targetDb: string,
  markerTable: string
): Promise<boolean> {
  const sourceCount = await countTableRows(container, sourceDb, markerTable)
  const targetCount = await countTableRows(container, targetDb, markerTable)

  if (sourceCount <= 0) return false
  return targetCount <= 0
}

function copyMcpServers(mainWorktreePath: string, targetWorktreePath: string): void {
  const claudeConfigPath = path.join(os.homedir(), ".claude.json")

  if (!fs.existsSync(claudeConfigPath)) {
    console.log("No ~/.claude.json found, skipping MCP server setup")
    return
  }

  console.log("Copying MCP server configuration...")

  const config: ClaudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf-8"))

  if (!config.projects) {
    console.log("No projects in ~/.claude.json, skipping MCP server setup")
    return
  }

  const mainProjectConfig = config.projects[mainWorktreePath]
  if (!mainProjectConfig?.mcpServers || Object.keys(mainProjectConfig.mcpServers).length === 0) {
    console.log("No MCP servers configured in main worktree, skipping")
    return
  }

  if (!config.projects[targetWorktreePath]) {
    config.projects[targetWorktreePath] = {}
  }

  config.projects[targetWorktreePath].mcpServers = { ...mainProjectConfig.mcpServers }
  config.projects[targetWorktreePath].enabledMcpjsonServers = mainProjectConfig.enabledMcpjsonServers || []
  config.projects[targetWorktreePath].disabledMcpjsonServers = mainProjectConfig.disabledMcpjsonServers || []
  config.projects[targetWorktreePath].hasTrustDialogAccepted = mainProjectConfig.hasTrustDialogAccepted

  fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2))

  const serverCount = Object.keys(mainProjectConfig.mcpServers).length
  const serverNames = Object.keys(mainProjectConfig.mcpServers).join(", ")
  console.log(`Copied ${serverCount} MCP server(s): ${serverNames}`)
}

async function main() {
  const cwd = process.cwd()
  console.log(`Setting up worktree at: ${cwd}`)

  const worktrees = await getWorktrees()
  const currentWorktree = worktrees.find((w) => w.path === cwd)
  const mainWorktree = getMainWorktree(worktrees)

  if (!mainWorktree) {
    console.error("Could not find main worktree")
    process.exit(1)
  }

  const isMainWorktree = currentWorktree?.isMain || mainWorktree.path === cwd
  if (isMainWorktree) {
    console.log("This appears to be the main worktree. No special setup needed.")
    console.log("Running bun install...")
    await $`bun install`
    console.log("Done!")
    process.exit(0)
  }

  console.log(`Main worktree: ${mainWorktree.path}`)

  console.log("Installing dependencies...")
  await $`bun install`

  const sourceEnvPath = path.join(mainWorktree.path, "apps/backend/.env")
  const targetEnvPath = path.join(cwd, "apps/backend/.env")

  if (!fs.existsSync(sourceEnvPath)) {
    console.error(`No .env file found at ${sourceEnvPath}`)
    console.log("Please ensure the main worktree has apps/backend/.env configured")
    process.exit(1)
  }

  console.log(`Copying .env from ${sourceEnvPath}...`)
  const originalEnvContent = fs.readFileSync(sourceEnvPath, "utf-8")

  const sourceDbName = extractDatabaseName(originalEnvContent)
  if (!sourceDbName) {
    console.error("Could not extract database name from main worktree's .env")
    process.exit(1)
  }

  const dbName = deriveDatabaseName(cwd)
  console.log(`Database name for this worktree: ${dbName}`)
  console.log(`Source database to clone: ${sourceDbName}`)

  const envContent = updateDatabaseUrl(originalEnvContent, dbName)
  fs.writeFileSync(targetEnvPath, envContent)
  console.log(`Created ${targetEnvPath}`)

  // Extract the actual target DB name from the written .env (source of truth for CP derivation)
  const targetDbName = extractDatabaseName(envContent)
  if (!targetDbName) {
    console.error("Could not extract database name from written backend .env")
    process.exit(1)
  }

  // CP database is always {backend_db_name}_cp — same derivation as dev.ts
  const cpSourceEnvPath = path.join(mainWorktree.path, "apps/control-plane/.env")
  const cpTargetEnvPath = path.join(cwd, "apps/control-plane/.env")
  const cpDbUrl = `postgresql://threa:threa@localhost:5454/${targetDbName}_cp`
  if (fs.existsSync(cpSourceEnvPath)) {
    console.log(`Copying control-plane .env from ${cpSourceEnvPath}...`)
    let cpEnvContent = fs.readFileSync(cpSourceEnvPath, "utf-8")
    if (cpEnvContent.includes("DATABASE_URL=")) {
      cpEnvContent = cpEnvContent.replace(/DATABASE_URL=.*/, `DATABASE_URL=${cpDbUrl}`)
    } else {
      cpEnvContent = `DATABASE_URL=${cpDbUrl}\n${cpEnvContent}`
    }
    fs.writeFileSync(cpTargetEnvPath, cpEnvContent)
  } else {
    fs.writeFileSync(cpTargetEnvPath, `DATABASE_URL=${cpDbUrl}\nFAST_SHUTDOWN=true\n`)
  }
  console.log(`Control-plane DATABASE_URL: ${cpDbUrl}`)

  try {
    const container = await findPostgresContainer()
    if (!container) {
      throw new Error("No running postgres container found")
    }

    const created = await createDatabaseIfNotExists(targetDbName)
    const forceClone = process.env.FORCE_DB_CLONE === "1"
    const needsClone =
      !created && !forceClone
        ? await existingDatabaseNeedsClone(container, sourceDbName, targetDbName, "workspaces")
        : false

    if (created || forceClone || needsClone) {
      if (!created && forceClone) {
        console.log(`FORCE_DB_CLONE=1 set, cloning into existing database '${targetDbName}'...`)
      } else if (needsClone) {
        console.log(`Existing database '${targetDbName}' appears unseeded; cloning from '${sourceDbName}'...`)
      }
      await cloneDatabase(container, sourceDbName, targetDbName)
    } else {
      console.log(`Skipping clone because database '${targetDbName}' already exists`)
      console.log(`Set FORCE_DB_CLONE=1 to force clone into existing database`)
    }

    // Create and clone control-plane database ({backend_db}_cp, same as dev.ts)
    const cpDbName = `${targetDbName}_cp`
    const sourceCpDbName = `${sourceDbName}_cp`
    const cpCreated = await createDatabaseIfNotExists(cpDbName)
    const cpNeedsClone =
      !cpCreated && !forceClone
        ? await existingDatabaseNeedsClone(container, sourceCpDbName, cpDbName, "workspace_registry")
        : false

    if (cpCreated || forceClone || cpNeedsClone) {
      if (!cpCreated && forceClone) {
        console.log(`FORCE_DB_CLONE=1 set, cloning into existing database '${cpDbName}'...`)
      } else if (cpNeedsClone) {
        console.log(`Existing database '${cpDbName}' appears unseeded; cloning from '${sourceCpDbName}'...`)
      }
      await cloneDatabase(container, sourceCpDbName, cpDbName)
    } else {
      console.log(`Skipping clone because database '${cpDbName}' already exists`)
    }
  } catch (err) {
    if (err instanceof Error) {
      console.warn(`Clone error: ${err.message}`)
    }
    console.warn("Could not create/clone database - ensure docker is running and postgres is started")
    console.warn("Run 'bun run db:start' from the main worktree, then run this script again")
  }

  try {
    copyMcpServers(mainWorktree.path, cwd)
  } catch (err) {
    console.warn("Could not copy MCP server configuration:", err)
  }

  console.log("\nWorktree setup complete!")
  console.log("\nNext steps:")
  console.log("  1. Ensure postgres is running: bun run db:start")
  console.log("  2. Start development: bun run dev")
}

main().catch((err) => {
  console.error("Setup failed:", err)
  process.exit(1)
})
