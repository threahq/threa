export interface WorkflowRun {
  workflowName: string
  status: string
  conclusion: string | null
  headSha: string
  createdAt: string
  url: string
  databaseId: number
}

export type ExecLike = (cmd: string[]) => Promise<{ stdout: string; exitCode: number; stderr: string }>

export async function bunExec(cmd: string[]): Promise<{ stdout: string; exitCode: number; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

/** Workflow runs on main for one commit (`gh run list --commit`). */
export async function runsForCommit(exec: ExecLike, repo: string, sha: string): Promise<WorkflowRun[]> {
  const { stdout, exitCode, stderr } = await exec([
    "gh",
    "run",
    "list",
    "--repo",
    repo,
    "--commit",
    sha,
    "--limit",
    "30",
    "--json",
    "workflowName,status,conclusion,headSha,createdAt,url,databaseId",
  ])
  if (exitCode !== 0) throw new Error(`gh run list failed: ${stderr.trim() || exitCode}`)
  return JSON.parse(stdout) as WorkflowRun[]
}

export async function remoteMainSha(exec: ExecLike): Promise<string> {
  const { stdout, exitCode, stderr } = await exec(["git", "ls-remote", "origin", "refs/heads/main"])
  if (exitCode !== 0) throw new Error(`git ls-remote failed: ${stderr.trim() || exitCode}`)
  const sha = stdout.trim().split(/\s+/)[0]
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error(`unexpected ls-remote output: ${stdout.trim()}`)
  return sha
}

/** Picks the newest run per workflow name. */
export function latestRunPerWorkflow(runs: WorkflowRun[]): Map<string, WorkflowRun> {
  const out = new Map<string, WorkflowRun>()
  for (const run of [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    if (!out.has(run.workflowName)) out.set(run.workflowName, run)
  }
  return out
}
