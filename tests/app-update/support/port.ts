import * as net from "node:net"

export function reserveServerPortSync(environmentKey: string): number {
  const configured = process.env[environmentKey]
  const requested = configured === undefined ? 0 : Number(configured)
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535 || (configured !== undefined && !requested)) {
    throw new Error(`Invalid ${environmentKey}: ${configured}`)
  }
  if (configured !== undefined) return requested
  const reservation = net.createServer()
  reservation.listen(requested)
  const address = reservation.address()
  if (typeof address !== "object" || !address) throw new Error(`Could not reserve ${environmentKey}`)
  reservation.close()
  process.env[environmentKey] = String(address.port)
  return address.port
}
