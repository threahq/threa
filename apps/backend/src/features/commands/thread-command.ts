import type { Command, CommandResult } from "./registry"

export const THREAD_COMMAND = "thread"

/**
 * /thread <message> — a one-off threaded answer from the linked session. The
 * dispatcher persists the message with the reply-in-thread marker; by the time
 * this runs, routing has already taken it from there.
 */
export class ThreadCommand implements Command {
  name = THREAD_COMMAND
  description = "Send a message the linked session answers in a thread"
  args = [{ name: "message", required: true, description: "The message to send" }]

  async execute(): Promise<CommandResult> {
    return { success: true, result: { replyInThread: true } }
  }
}
