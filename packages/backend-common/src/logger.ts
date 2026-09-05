import pino from "pino"

const isProduction = process.env.NODE_ENV === "production"
const testLogFile = process.env.THREA_TEST_LOG_FILE
const level = (process.env.LOG_LEVEL || "info") as pino.Level
const prettyTransport = {
  target: "pino-pretty",
  options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname" },
}

// Every entry carries the logger's own level: a multistream entry defaults to
// `info`, so without this LOG_LEVEL=debug would emit records nothing accepts.
const destinations: pino.StreamEntry[] = [
  { level, stream: isProduction ? process.stdout : pino.transport(prettyTransport) },
]
if (testLogFile) {
  destinations.push({ level, stream: pino.destination({ dest: testLogFile, mkdir: true, sync: false }) })
}

const streams = pino.multistream(destinations)

export const logger = pino({ level, serializers: { error: pino.stdSerializers.err } }, streams)

/**
 * Add a destination to the live logger. Exists so log shipping can attach after
 * boot, once config is known, without the logger importing the shipper.
 */
export function addLogDestination(entry: pino.StreamEntry): void {
  streams.add(entry)
}
