# DeployDoctor: catch Vercel deploy failures in the pull request

Scans a pull request for the mistakes that break a Vercel deploy, before Vercel builds it. Static analysis through the GitHub API; nothing is cloned, installed or executed.

It checks the things that pass locally and fail on Vercel:

- imports that only resolve on a case-insensitive disk (macOS, Windows)
- `process.env` reads that no `.env.example` documents
- packages that are used but not declared, and lockfile drift
- Node-only modules on the Edge runtime
- Prisma without `prisma generate`
- live secrets committed to source

Each finding is annotated on the file and line in the pull request, with the fix. One PR conversation comment shows the top findings, immutable scanned commit and full report link. New runs update that comment instead of posting another one. The job summary remains available too.

**Free on public repositories**: no account, no token, 1 scan a day per repository.

```yaml
name: DeployDoctor
on:
  pull_request:
concurrency:
  group: deploydoctor-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true
jobs:
  deploydoctor:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write # lets the built-in workflow token maintain the PR comment
      id-token: write # GitHub proves which public repository is asking
    steps:
      - uses: jonjys/deploydoctor-action@v1
```

When the free scan for the day is used, the comment changes to **Not scanned**, the job summary explains the limit, and the job warns and passes. An old green result is not presented as a result for the new commit. Capacity/API failures remain failed scans. Pull requests from forks and from Dependabot are skipped the same way, in the free workflow when OIDC is unavailable. Comments are always disabled for forks and Dependabot, including paid scans. Do not switch to `pull_request_target` to bypass this.

Private repository or unlimited scans: create an API token under My scans while a pass is active and pass it as `token`. For a private repository, also add `github-token: ${{ github.token }}` so the scan can read it.

| Input | Default | Meaning |
| --- | --- | --- |
| `token` | empty | API token from My scans on deploydoctor.nyttolabs.com, while a pass is active. Leave it out on a public repository to scan for free. |
| `repository` | the workflow's repository | `owner/name` to scan. |
| `ref` | the pull request head, or the pushed commit | Branch, tag or commit to scan. |
| `github-token` | empty | Read token for private repositories, usually `${{ github.token }}`. Forwarded for this scan, never stored. |
| `fail-on` | `red` | `red`, `yellow` or `never`. |
| `checks` | stack-detected | Comma-separated: `next`, `vercel`, `env`, `supabase`, `prisma`. |
| `comment` | `true` | Maintain one PR conversation comment. Set `false` to keep annotations/summary only. |
| `comment-token` | `${{ github.token }}` | Built-in workflow token for GitHub comments only. Never sent to DeployDoctor. Grant `pull-requests: write`; no personal token needed. |
| `audit-link` | `true` | Small footer linking the existing optional one-repo human audit (€149). Set `false` to omit it. |

Outputs: `overall` (red, yellow, green), `report-url`, `red`, `yellow`, plus `comment-status` (`created`, `updated`, `skipped`, `stale`, `failed`) and `comment-url` when a comment was written.

## PR comment behavior and permissions

Use one scan job per PR and the concurrency group above. The Action searches up to 1,000 comments for its own `github-actions[bot]` marker, updates the original, and never treats a human comment as its own. It checks the live PR head before writing so an older scan is skipped after another push. GitHub has no atomic head-SHA condition on comment updates: workflow concurrency avoids competing writers; a push during the final API write can briefly leave an older SHA visible. The commit is always explicit.

Comments only apply to same-repository `pull_request` events, the default head SHA, and a saved report whose repository and `commitSha` match. Push events, forks, Dependabot, closed PRs, overridden repositories/refs and unmatched reports are not commented. Partial scans say so. Private reports retain their existing owner authentication; a private repository comment is visible to that repository's readers, not a way to unlock the report.

The `comment-token` stays in the runner and goes only to the fixed GitHub API origin. It is separate from `github-token`, which is explicitly forwarded to the scanner only when you request private-source access. No PR code is checked out, built or executed by this Action. Source text in the comment is escaped to prevent mentions or injected links.

A missing/limited comment token or GitHub write-permission failure produces a warning and leaves the scan's exit status intact. Existing installs need the additional `pull-requests: write` permission to get comments. `comment: false` opts out. Audit links are optional and do not affect findings or payment entitlements.

## Free webhook replay lab

One payment can arrive at your webhook more than once. [Try the free replay lab](https://deploydoctor.nyttolabs.com/webhook-replay-lab?utm_source=github-action&utm_medium=readme&utm_campaign=break-my-checkout) to compare duplicate deliveries, worker restarts and crash recovery before reviewing your own handler.

The lab runs in your browser with sample events; it sends no live payments and does not validate your checkout. Then [scan your repository](https://deploydoctor.nyttolabs.com/?utm_source=github-action&utm_medium=readme#scan-repository) for source-backed deployment and payment-risk findings. The existing [$2 one-time 24-hour pass](https://deploydoctor.nyttolabs.com/pricing) includes private repos, subject to capacity and GitHub limits.

Full documentation: https://deploydoctor.nyttolabs.com/ci

Source of the scanner: https://github.com/jonjys/deploydoctor. Questions: support@nyttolabs.com

## PR Change Review

On a matching same-repository PR-head scan, the Action asks DeployDoctor to compare the head with its immutable merge base. The single PR comment separates newly detected findings, existing findings, and findings no longer detected, with fixed-commit source links. Partial or incomparable observations require review. A missing comparison from an older/self-hosted server keeps the normal head-scan comment.

This uses one existing scan allowance and the same paid/private permissions. `fail-on` still applies to the full head scan, including existing problems; it does not silently become a new-findings-only gate. The comparison does not build the merge result or prove a fix. Forks, Dependabot and ref overrides keep the existing behavior. Update your pinned Action SHA to a release containing this feature; an older `v1` tag does not automatically gain it.
