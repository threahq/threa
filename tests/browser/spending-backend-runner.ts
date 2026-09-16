import { createDatabasePool } from "../../apps/backend/src/db"
import { startServer } from "../../apps/backend/src/server"

const audit = createDatabasePool(process.env.DATABASE_URL!, { max: 2 })
await audit.query("CREATE TABLE IF NOT EXISTS spending_test_egress (id BIGSERIAL PRIMARY KEY, body JSONB NOT NULL)")

const server = await startServer({
  aiFetch: async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url !== "https://openrouter.ai/api/v1/chat/completions" || init?.method !== "POST") {
      throw new Error(`Unexpected paid transport request in spending test: ${url}`)
    }
    const body = JSON.parse(String(init.body))
    const result = await audit.query<{ id: string }>(
      "INSERT INTO spending_test_egress (body) VALUES ($1) RETURNING id",
      [JSON.stringify(body)]
    )
    return Response.json({
      id: `gen-spending-test-${result.rows[0]!.id}`,
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call-send-${result.rows[0]!.id}`,
                type: "function",
                function: {
                  name: "send_message",
                  arguments: JSON.stringify({ content: "Your protected assistant reply." }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.0001 },
    })
  },
})

let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await server.stop()
  await audit.end()
  process.exit(0)
}
process.on("SIGTERM", () => void stop())
process.on("SIGINT", () => void stop())
