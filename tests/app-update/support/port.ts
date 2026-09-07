import * as net from "node:net"
import { readFile, writeFile, rm } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const PORT_FILE = join(__dirname, "..", ".server-port")

function findFreePortSync(): number {
  const server = net.createServer()
  server.listen(0)
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  server.close()
  return port
}

export function reserveServerPortSync(): number {
  const port = process.env.APP_UPDATE_SERVER_PORT ? Number(process.env.APP_UPDATE_SERVER_PORT) : findFreePortSync()
  process.env.APP_UPDATE_SERVER_PORT = String(port)
  writeFileSync(PORT_FILE, String(port))
  return port
}

export async function writeServerPort(port: number): Promise<void> {
  await writeFile(PORT_FILE, String(port))
}

export async function clearServerPort(): Promise<void> {
  try {
    await rm(PORT_FILE)
  } catch {
    // ignore
  }
}

export async function readServerPort(): Promise<number | null> {
  try {
    const saved = Number(await readFile(PORT_FILE, "utf-8"))
    return Number.isNaN(saved) ? null : saved
  } catch {
    return null
  }
}
