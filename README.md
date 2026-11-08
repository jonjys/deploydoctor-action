# DeployDoctor: catch Vercel deploy failures in the pull request

Scans a pull request for the mistakes that break a Vercel deploy, before Vercel builds it. Static analysis through the GitHub API; nothing is cloned, installed or executed.

It checks the things that pass locally and fail on Vercel:

- imports that only resolve on a case-insensitive disk (macOS, Windows)
- `process.env` reads that no `.env.example` documents
- packages that are used but not declared, and lockfile drift
- Node-only modules on the Edge runtime
- Prisma without `prisma generate`
- live secrets committed to source

Each finding is annotated on the file and line in the pull request, with the fix. One sticky pull request comment summarizes the deploy risks, names the scanned commit, and links the full DeployDoctor report. A later run updates that comment instead of posting another one. The job summary remains available too.

**Free on public repositories**: no account, no token, 1 scan a day per repository. The job passes unless you set `fail-on-high-risk: true`.

## Copy-paste workflow

Save this as `.github/workflows/deploydoctor.yml`. `pull-requests: write` lets the built-in `GITHUB_TOKEN` (`github.token`) create and update the one comment. No personal access token is required.

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
      pull-requests: write
      id-token: write
    steps:
      - uses: jonjys/deploydoctor-action@v1
        with:
          fail-on-high-risk: false
```

Set `fail-on-high-risk: true` to fail the job when the report contains high-risk (red) findings, or when the scan cannot finish. With `false`, those outcomes are still written to the comment and the job passes. Set `fail-on: red` for the same finding gate without failing a scan that cannot finish, or `fail-on: yellow` to fail on review items too. Using up the free daily scan posts **Not scanned** and the job passes either way.

When the free scan for the day is used, the comment changes to **Not scanned**, the job summary explains the limit, and the job warns and passes. An old green result is not presented as a result for the new commit. If the scan cannot finish, the same comment changes to **Scan failed** and the job passes unless `fail-on-high-risk` is `true`. Pull requests from forks and from Dependabot are skipped the same way, in the free workflow when OIDC is unavailable. Comments are always disabled for forks and Dependabot, including paid scans. Do not switch to `pull_request_target` to bypass this.

Private repository or unlimited scans: create an API token under My scans while a pass is active and pass it as `token`. For a private repository, also add `github-token: ${{ github.token }}` so the scan can read it.

| Input | Default | Meaning |
| --- | --- | --- |
| `token` | empty | API token from My scans on deploydoctor.nyttolabs.com, while a pass is active. Leave it out on a public repository to scan for free. |
| `repository` | the workflow's repository | `owner/name` to scan. |
| `ref` | the pull request head, or the pushed commit | Branch, tag or commit to scan. |
| `github-token` | empty | Read token for private repositories, usually `${{ github.token }}`. Forwarded for this scan, never stored. |
| `fail-on-high-risk` | `false` | `true` fails the job on high-risk (red) findings and when the scan cannot finish. `false` reports both and passes. Free daily allowance exhaustion still passes. |
| `fail-on` | `never` | `never` only reports. `red` fails the job when high-risk findings are present. `yellow` also fails when a check needs review. Scan request failures stay non-blocking unless `fail-on-high-risk` is true. |
| `checks` | stack-detected | Comma-separated: `next`, `vercel`, `env`, `supabase`, `prisma`. |
| `comment` | `true` | Maintain one sticky PR conversation comment. Set `false` to keep annotations and the job summary only. |
| `comment-token` | `${{ github.token }}` | Built-in workflow token for GitHub comments only. Never sent to DeployDoctor. Grant `pull-requests: write`. |
| `audit-link` | `false` | Accepted for older workflows. The comment does not include a paid audit offer. |

Outputs: `overall` (red, yellow, green), `report-url`, `red`, `yellow`, plus `comment-status` (`created`, `updated`, `skipped`, `stale`, `failed`) and `comment-url` when a comment was written.

Saved reports use `https://deploydoctor.nyttolabs.com/r/<report-id>`. The comment links that URL only when it is https on the action's DeployDoctor origin, with no userinfo, query, or fragment.

## Example comment

This is the shape of the sticky comment. It is an illustration, not a result from a live repository. The HTML marker is how a later run finds the comment to update.

```markdown
<!-- deploydoctor:pr-report:v1 -->
## DeployDoctor · Source findings

Analyzed commit: [aaaaaaaaaaaa](https://github.com/acme/site/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa).

Deploy risks: 1 high-risk (red) · 1 to review · 4 passed.

- **Source finding** · [src/home.ts:3](https://github.com/acme/site/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/src/home.ts#L3)
  Import path casing differs from the target file.
  Next step: change the import to use the committed filename casing.

- **Needs review** · [app/api/webhook/route.ts:9](https://github.com/acme/site/blob/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/app/api/webhook/route.ts#L9)
  A check followed by a separate write can race between two deliveries.
  Next step: inspect the durable claim, unique constraints and transaction boundaries.

[Open the full DeployDoctor report](https://deploydoctor.nyttolabs.com/r/example-report)

Static source analysis only. Builds, runtime behavior and payment fulfillment were not executed.
```

When the scan cannot finish, the same comment becomes:

```markdown
<!-- deploydoctor:pr-report:v1 -->
## DeployDoctor · Scan failed

Requested commit: [aaaaaaaaaaaa](https://github.com/acme/site/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa).

The scan did not finish (HTTP 503). No deploy-risk result is available for this commit. Check the workflow job and rerun to update this comment.

This replaces the previous comment; a previous pass is not a result for this commit.

Static source analysis only. Builds, runtime behavior and payment fulfillment were not executed.
```

## PR comment behavior and permissions

Use one scan job per PR and the concurrency group above. The Action searches up to 1,000 comments for its own `github-actions[bot]` marker, updates the oldest one, and deletes later duplicates of that marker so the pull request keeps a single comment. It never treats a human comment as its own. An identical body is left in place. It checks the live PR head before writing so an older scan is skipped after another push. GitHub has no atomic head-SHA condition on comment updates: workflow concurrency avoids competing writers; a push during the final API write can briefly leave an older SHA visible. The commit is always explicit.

`pull-requests: write` on the job is the permission `GITHUB_TOKEN` needs. The comment is a pull request conversation comment. A missing or read-only `comment-token` produces a warning and leaves the scan result's exit status unchanged.

Comments only apply to same-repository `pull_request` events, the default head SHA, and a saved report whose repository and `commitSha` match. Push events, forks, Dependabot, closed PRs, overridden repositories/refs and unmatched reports are not commented. Partial scans say so. Private reports retain their existing owner authentication; a private repository comment is visible to that repository's readers, not a way to unlock the report.

The `comment-token` stays in the runner and goes only to the fixed GitHub API origin. It is separate from `github-token`, which is explicitly forwarded to the scanner only when you request private-source access. No PR code is checked out, built or executed by this Action. Source text in the comment is escaped to prevent mentions or injected links.

A missing or limited comment token, or a GitHub write-permission failure, produces a warning and leaves the scan's exit status intact. Existing installs need `pull-requests: write` to get comments. `comment: false` opts out.

## Free webhook replay lab

One payment can arrive at your webhook more than once. [Try the free replay lab](https://deploydoctor.nyttolabs.com/webhook-replay-lab?utm_source=github-action&utm_medium=readme&utm_campaign=break-my-checkout) to compare duplicate deliveries, worker restarts and crash recovery before reviewing your own handler.

The lab runs in your browser with sample events; it sends no live payments and does not validate your checkout. Then [scan your repository](https://deploydoctor.nyttolabs.com/?utm_source=github-action&utm_medium=readme#scan-repository) for source-backed deployment and payment-risk findings. The existing [$2 one-time 24-hour pass](https://deploydoctor.nyttolabs.com/pricing) includes private repos, subject to capacity and GitHub limits.

Full documentation: https://deploydoctor.nyttolabs.com/ci

Source of the scanner: https://github.com/jonjys/deploydoctor. Questions: support@nyttolabs.com

## PR Change Review

On a matching same-repository PR-head scan, the Action asks DeployDoctor to compare the head with its immutable merge base. The single PR comment separates newly detected findings, existing findings, and findings no longer detected, with fixed-commit source links. Partial or incomparable observations require review. A missing comparison from an older/self-hosted server keeps the normal head-scan comment.

This uses one existing scan allowance and the same paid/private permissions. `fail-on` and `fail-on-high-risk` still apply to the full head scan, including existing problems; neither becomes a new-findings-only gate. The comparison does not build the merge result or prove a fix. Forks, Dependabot and ref overrides keep the existing behavior. Update your pinned Action SHA to a release containing this feature; an older `v1` tag does not automatically gain it.
