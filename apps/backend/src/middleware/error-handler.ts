import type { Request, Response, NextFunction } from "express"
import { MulterError } from "multer"
import { logger } from "../lib/logger"

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large" })
    }
    return res.status(400).json({ error: err.message })
  }

  // Handle file filter rejection (from fileFilter callback)
  if (err.message?.includes("not allowed")) {
    return res.status(400).json({ error: err.message })
  }

  logger.error({ err, path: req.path, method: req.method }, "Unhandled error")

  res.status(500).json({ error: "Internal server error" })
}
