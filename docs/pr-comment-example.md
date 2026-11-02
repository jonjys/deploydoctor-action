# Illustrative PR comment

The following is a fixture example, not a screenshot or evidence of a real deployment failure. Production comments use the saved report's immutable commit, source evidence and report URL.

## DeployDoctor · Source findings

Analyzed commit: `aaaaaaaaaaaa`.

Red checks: 1 · To review: 1 · Passed: 4.

- **Source finding** · `src/home.ts:3`
  Import path casing differs from the target file.
  Next step: change the import to use the committed filename casing.

- **Needs review** · `app/api/webhook/route.ts:9`
  A check followed by a separate write can race between two deliveries.
  Next step: inspect the durable claim, unique constraints and transaction boundaries.

Open full report → the actual saved report URL.

Static source analysis only. Builds, runtime behavior and payment fulfillment were not executed.

Optional footer: one-repo human audit, €149. This links the existing offer, not a new product or subscription.

## Verified implementation boundaries

14 Node tests currently pass, including the original scan/quota/annotation cases. Tests use a mocked GitHub API: create, update, pagination, human-marker spoofing, stale/closed PRs, partial coverage, quota/error outcomes, missing permission, opt-out, forks, and separation of comment-token from scanner requests. No live GitHub comment is claimed solely on this basis.

The existing release workflow tests both modules before updating v1 with a lease on its previous SHA. A merged branch is not proof that v1 moved: verify the tag and workflow run after merge. No new account, price, secret or scan quota is introduced.
