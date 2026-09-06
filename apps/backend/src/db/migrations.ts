import { Pool } from "pg"
import path from "path"
import { runMigrations as runMigrationsBase, createMigrator as createMigratorBase } from "@threahq/backend-common"

const BACKEND_MIGRATIONS_GLOB = path.join(import.meta.dirname, "migrations/*.sql")

export function createMigrator(pool: Pool) {
  return createMigratorBase(pool, BACKEND_MIGRATIONS_GLOB)
}

export async function runMigrations(pool: Pool): Promise<void> {
  return runMigrationsBase(pool, BACKEND_MIGRATIONS_GLOB)
}
