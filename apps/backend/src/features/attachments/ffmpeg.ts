export const INPUT_PROTOCOLS = "http,https,tcp,tls"
const STDERR_TAIL_BYTES = 4096

export interface MediaTools {
  ffmpegPath: string
  ffprobePath: string
}

/** The input is readable but is not media ffmpeg can decode; retrying cannot help. */
export class UndecodableMediaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UndecodableMediaError"
  }
}

export function resolveMediaTools(): MediaTools | null {
  const ffmpegPath = Bun.which("ffmpeg")
  const ffprobePath = Bun.which("ffprobe")
  if (!ffmpegPath || !ffprobePath) return null
  return { ffmpegPath, ffprobePath }
}

/** ffmpeg's fixed messages for input that matches no known format, or one outside the allowed list. */
const UNDECODABLE_STDERR = /Invalid data found when processing input|Format not on whitelist/

export interface RunResult {
  exitCode: number
  stdout: string
  stderrTail: string
}

async function readTail(stream: ReadableStream<Uint8Array>): Promise<string> {
  let tail = Buffer.alloc(0)
  for await (const chunk of stream) {
    tail = Buffer.concat([tail, chunk])
    if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES)
  }
  return tail.toString("utf8").trim()
}

/** The presigned input URL carries a live signature, so it never reaches error messages. */
export async function runTool(
  cmd: string[],
  inputUrl: string,
  timeoutMs: number,
  onStdout?: (chunk: Uint8Array) => void
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGKILL")
  }, timeoutMs)
  try {
    const stderrTail = readTail(proc.stderr)
    let stdout = ""
    if (onStdout) {
      for await (const chunk of proc.stdout) onStdout(chunk)
    } else {
      stdout = await new Response(proc.stdout).text()
    }
    const exitCode = await proc.exited
    const tail = (await stderrTail).replaceAll(inputUrl, "<input>")
    if (timedOut) throw new Error(`${cmd[0]} timed out after ${timeoutMs} ms: ${tail}`)
    return { exitCode, stdout, stderrTail: tail }
  } catch (error) {
    proc.kill("SIGKILL")
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export function toolFailure(tool: string, result: RunResult): Error {
  const message = `${tool} exited with ${result.exitCode}: ${result.stderrTail}`
  return UNDECODABLE_STDERR.test(result.stderrTail) ? new UndecodableMediaError(message) : new Error(message)
}
