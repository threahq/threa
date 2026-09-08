/**
 * Default pino-http serializers dump every header, so a new secret header
 * leaks by omission; this allowlist means only these fields ever reach a log.
 */
export const requestLogSerializers = {
  req(req: { id?: string; method: string; url: string; headers: Record<string, string | undefined> }) {
    return {
      id: req.id,
      method: req.method,
      url: req.url,
      userAgent: req.headers["user-agent"],
    }
  },
  res(res: { statusCode: number }) {
    return { statusCode: res.statusCode }
  },
}
