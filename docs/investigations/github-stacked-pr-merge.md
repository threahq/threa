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
