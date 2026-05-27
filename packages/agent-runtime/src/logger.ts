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

export const logger = (() => {
  if (!testLogFile) {
    return pino({
      ...baseOptions,
      transport: isProduction ? undefined : prettyTransport,
    })
  }

  const primaryStream = isProduction ? process.stdout : pino.transport(prettyTransport)
  const fileStream = pino.destination({
    dest: testLogFile,
    mkdir: true,
    sync: false,
  })

  return pino(baseOptions, pino.multistream([{ stream: primaryStream }, { stream: fileStream }]))
})()
