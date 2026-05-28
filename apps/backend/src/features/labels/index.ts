export { LabelRepository, LabelMemberRepository, LabelAssignmentRepository } from "./repository"
export type { InsertLabelParams, UpdateLabelParams, AssignmentKey } from "./repository"

export { LabelService } from "./service"
export type { CreateLabelParams } from "./service"

export { LabelAssignmentService } from "./assignment-service"
export type { AssignLabelParams } from "./assignment-service"

export { createLabelHandlers } from "./handlers"
