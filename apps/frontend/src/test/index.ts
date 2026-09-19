/**
 * Test utilities - import from "@/test" for all test helpers.
 *
 * @example
 * ```tsx
 * import { render, screen, userEvent, waitFor, spyOnExport } from "@/test"
 * import { createMockStream, mockStreams, mockUsers } from "@/test/fixtures"
 * ```
 */

export * from "./render"

export { spyOnExport } from "./spy"

export { stubImageLoading } from "./image"

// Fixtures live in "@/test/fixtures" for data factories.
