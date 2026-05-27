import pino from "pino"

const isProduction = process.env.NODE_ENV === "production"
const prettyTransport = {
  target: "pino-pretty",
  options: {
    colorize: true,
    translateTime: "HH:MM:ss",
    ignore: "pid,hostname",
  },
}

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  serializers: { error: pino.stdSerializers.err },
  transport: isProduction ? undefined : prettyTransport,
})
