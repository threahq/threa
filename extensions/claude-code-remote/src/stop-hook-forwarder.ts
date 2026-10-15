import { connect } from "node:net"

const FORWARD_TIMEOUT_MS = 2_000

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

function forward(socketPath: string, payload: string): Promise<void> {
  return new Promise((resolve) => {
    const socket = connect(socketPath)
    const timer = setTimeout(() => socket.destroy(), FORWARD_TIMEOUT_MS)
    socket.on("connect", () => socket.end(payload))
    socket.on("close", () => {
      clearTimeout(timer)
      resolve()
    })
    socket.on("error", () => undefined)
  })
}

if (import.meta.main) {
  const socketPath = process.argv[2]
  try {
    const payload = await readStdin()
    if (socketPath && payload.trim()) await forward(socketPath, payload)
  } catch {
    // The hook must never block or fail Claude's stop; a missing channel is not an error here.
  }
  process.exit(0)
}
