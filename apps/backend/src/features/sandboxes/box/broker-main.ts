import { BROKER_PORT, startBroker } from "./broker"

// Runs in the box as root (Railway) or as the backend's uid (Docker), never as
// the sandbox user, so the command can read neither its environment nor its memory.
const { THREA_SANDBOX_TOKEN: token, THREA_WORKSPACE_ID: workspaceId, THREA_API_UPSTREAM: upstream } = process.env
if (!token || !workspaceId || !upstream) {
  process.stderr.write("THREA_SANDBOX_TOKEN, THREA_WORKSPACE_ID and THREA_API_UPSTREAM are required\n")
  process.exit(2)
}

// The exec waits for this line before it starts the command.
startBroker({ token, workspaceId, upstream, port: BROKER_PORT }).on("listening", () => process.stdout.write("ready\n"))
