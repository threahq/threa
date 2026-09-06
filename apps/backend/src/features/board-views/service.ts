import { Pool } from "pg"
import { HttpError } from "../../lib/errors"
import { BoardViewRepository, type CreateBoardViewParams, type UpdateBoardViewParams } from "./repository"
import type { BoardView } from "@threahq/types"

/**
 * User-saved board lenses. Low-frequency
 * per-viewer config, so — like sidebar_configs — no outbox/transaction machinery;
 * each op is one race-safe query on the pool (INV-30/INV-20). Ownership is enforced
 * in the WHERE clause, so update/delete of another user's view 404s.
 */
export class BoardViewService {
  constructor(private pool: Pool) {}

  list(workspaceId: string, userId: string): Promise<BoardView[]> {
    return BoardViewRepository.listForUser(this.pool, workspaceId, userId)
  }

  create(params: CreateBoardViewParams): Promise<BoardView> {
    return BoardViewRepository.create(this.pool, params)
  }

  async update(workspaceId: string, userId: string, id: string, params: UpdateBoardViewParams): Promise<BoardView> {
    const updated = await BoardViewRepository.update(this.pool, workspaceId, userId, id, params)
    if (!updated) throw new HttpError("Board view not found", { status: 404, code: "BOARD_VIEW_NOT_FOUND" })
    return updated
  }

  async delete(workspaceId: string, userId: string, id: string): Promise<void> {
    const deleted = await BoardViewRepository.delete(this.pool, workspaceId, userId, id)
    if (!deleted) throw new HttpError("Board view not found", { status: 404, code: "BOARD_VIEW_NOT_FOUND" })
  }
}
