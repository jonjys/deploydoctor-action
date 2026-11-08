# Illustrative PR comment

The following is the shape produced by `renderComment`, not a screenshot or evidence of a live deployment failure. A real comment uses the saved report's immutable commit, source evidence, and report URL. Report links look like `https://deploydoctor.nyttolabs.com/r/<report-id>`.

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

## Scan failed

The same marker is updated when DeployDoctor does not return a report. The job stays green unless the workflow sets `fail-on-high-risk: true`.

```markdown
<!-- deploydoctor:pr-report:v1 -->
## DeployDoctor · Scan failed

Requested commit: [aaaaaaaaaaaa](https://github.com/acme/site/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa).

The scan did not finish (HTTP 503). No deploy-risk result is available for this commit. Check the workflow job and rerun to update this comment.

This replaces the previous comment; a previous pass is not a result for this commit.

Static source analysis only. Builds, runtime behavior and payment fulfillment were not executed.
```

## What the tests cover

Node tests exercise the comment renderer and `scan.mjs` with a mocked GitHub API and a mocked DeployDoctor response. They cover create, update, unchanged body, duplicate collapse, pagination, human-marker spoofing, stale or closed pull requests, partial coverage, quota and scan-failure outcomes, `fail-on-high-risk`, missing permission, opt-out, forks, and separation of `comment-token` from scanner requests. Those tests do not post a live GitHub comment.
