import pino from "pino"
import pretty from "pino-pretty"

const isProduction = process.env.NODE_ENV === "production"
const testLogFile = process.env.THREA_TEST_LOG_FILE
const prettyOptions = {
  colorize: true,
  translateTime: "HH:MM:ss",
  ignore: "pid,hostname",
}

const baseOptions = {
  level: process.env.LOG_LEVEL || "info",
  serializers: {
    error: pino.stdSerializers.err,
  },
}

// pino-pretty as a directly-imported, *synchronous* stream — NOT `pino.transport`,
// which spawns a worker thread that resolves the target module ("pino-pretty")
// from disk at runtime. The enclave ships as a single-file bundle with no
// node_modules for that worker to resolve, so the transport throws at
// construction there. A synchronous stream is bundled inline, so the SAME logger
// runs identically from source (the regional backend) and inside the enclave
// bundle — keeping their dev output aligned. Production stays plain JSON on
// stdout (no pretty) for log aggregation.
export const logger = (() => {
  if (!testLogFile) {
    return isProduction ? pino(baseOptions) : pino(baseOptions, pretty(prettyOptions))
  }

  const primaryStream = isProduction ? process.stdout : pretty(prettyOptions)
  const fileStream = pino.destination({
    dest: testLogFile,
    mkdir: true,
    sync: false,
  })

  return pino(baseOptions, pino.multistream([{ stream: primaryStream }, { stream: fileStream }]))
})()
