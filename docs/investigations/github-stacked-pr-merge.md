# GitHub stacked PR merge investigation

Status: 2026-07-20. GitHub Stacked PRs is in private preview; its interfaces may change without notice.

## Supported surfaces

`gh stack` v0.0.8 creates, updates, rebases, syncs, and dissolves stacks, but has no merge command. GitHub's preview [REST reference](https://github.github.com/gh-stack/reference/rest-api/) documents these endpoints:

- `GET /repos/{owner}/{repo}/stacks`
- `GET /repos/{owner}/{repo}/stacks/{stack_number}`
- `POST /repos/{owner}/{repo}/stacks`
- `POST /repos/{owner}/{repo}/stacks/{stack_number}/add`
- `POST /repos/{owner}/{repo}/stacks/{stack_number}/unstack`

The stack resource includes its base and ordered pull requests. Pull request resources also expose stack number, size, position, and base. Public GraphQL introspection exposes no stack type or mutation.

## Merge semantics

GitHub's [stacked PR guide](https://github.github.com/gh-stack/guides/stacked-prs/#merging-a-stack) defines merge by position: merging a pull request also merges every unmerged pull request below it. Merging the top pull request lands the whole stack; merging the bottom lands only that pull request. Remaining pull requests are rebased and retargeted after a partial merge.

The documented REST surface does not include the merge operation used by the web UI.

## Web merge request

The pull request UI performs a stack merge through an internal website endpoint on the selected pull request:

```http
POST /{owner}/{repo}/pull/{pull_number}/page_data/enqueue_stack
```

```json
{
  "commitTitle": "…",
  "commitMessage": "…",
  "mergeMethod": "SQUASH"
}
```

`mergeMethod` accepts `MERGE`, `SQUASH`, or `REBASE`. The UI also sends `authorEmail` when the account has selectable commit emails. Selecting a pull request merges that pull request and every unmerged entry below it, so the top pull request selects the whole stack.

This is a website route, not an `api.github.com` REST endpoint. It requires an authenticated GitHub web session and the page's rotating `X-Fetch-Nonce`, along with GitHub's verified-fetch headers. A GitHub API token does not authenticate this route.

## Probe results

- `POST` probes of `/stacks/{number}/merge`, `/merges`, `/stack-merge`, `/enqueue`, and `/enqueue_stack` all returned `404 Not Found` through `gh api`.
- A token-authenticated request to the website route failed before reaching the handler.
- An authenticated browser replay against completed stack 1437 reached the handler and returned `422` because the stack was already merged. The stack resource was unchanged.

A token-only `gh` command therefore cannot reproduce the web merge. Browser automation can invoke the route, but depends on private website behavior and a live browser session. Keep the documented per-layer CLI merge procedure as the non-browser fallback.

## Guarded wrapper

`.agents/skills/gh-stack/scripts/merge-stack.ts` packages the browser operation behind explicit `--yes`, a non-mutating `--dry-run`, exact stack/head validation, GitHub-only cookie snapshots, private DevTools pipes, completion polling, over-merge detection, and signal-safe cleanup.

Full-stack merges were live-validated twice: stacks 1443 and 1446 each merged two exact heads one second apart without unstacking. Partial-range validation succeeded on stack 1453: targeting middle PR 1451 merged PRs 1450 and 1451, left PR 1452 open, and retargeted it to `main`.
