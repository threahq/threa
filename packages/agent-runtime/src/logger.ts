import pino from "pino"

const isProduction = process.env.NODE_ENV === "production"
const testLogFile = process.env.THREA_TEST_LOG_FILE
const prettyTransport = {
  target: "pino-pretty",
  options: {
    colorize: true,
    translateTime: "HH:MM:ss",
    ignore: "pid,hostname",
  },
}

const baseOptions = {
  level: process.env.LOG_LEVEL || "info",
  serializers: {
    error: pino.stdSerializers.err,
  },
}

// pino-pretty runs as a worker thread that resolves its target module from
// disk. The enclave ships as a single-file bundle with no node_modules, so the
// transport can't be resolved there and pino throws at construction. Build it
// behind a guard and fall back to plain JSON on stdout when it isn't available,
// so the same code runs both from source (backend) and bundled (enclave).
function tryPrettyStream(): pino.DestinationStream | undefined {
  try {
    return pino.transport(prettyTransport)
  } catch {
    return undefined
  }
}

export const logger = (() => {
  if (!testLogFile) {
    if (isProduction) return pino(baseOptions)
    const pretty = tryPrettyStream()
    return pretty ? pino(baseOptions, pretty) : pino(baseOptions)
  }

  const primaryStream = isProduction ? process.stdout : (tryPrettyStream() ?? process.stdout)
  const fileStream = pino.destination({
    dest: testLogFile,
    mkdir: true,
    sync: false,
  })

  return pino(baseOptions, pino.multistream([{ stream: primaryStream }, { stream: fileStream }]))
})()
