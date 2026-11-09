// DeployDoctor GitHub Action. Plain Node, no dependencies: it POSTs to /api/reports with the API token,
// or without one with a GitHub OIDC token (free on public repositories), writes the result to the job
// summary, updates one pull request comment, and fails the job only when fail-on or fail-on-high-risk says so.
import { appendFileSync, readFileSync } from "node:fs";
import { pullRequestContext, upsertComment, text as markdownText } from "./pr-comment.mjs";

const env = (name, fallback = "") => (process.env[name] ?? fallback).trim();
const token = env("DD_TOKEN");
const repository = env("DD_REPOSITORY");
const ref = env("DD_REF");
const githubToken = env("DD_GITHUB_TOKEN");
const failOn = (env("DD_FAIL_ON") || "never").toLowerCase();
const failOnHighRisk = (env("DD_FAIL_ON_HIGH_RISK") || "false").toLowerCase();
// `audit-link` (DD_AUDIT_LINK) is accepted for older workflows and intentionally unused.
const checks = env("DD_CHECKS").split(",").map((item) => item.trim()).filter(Boolean);
const apiUrl = env("DD_API_URL", "https://deploydoctor.nyttolabs.com").replace(/\/+$/, "");

const commandText = value => String(value).replace(/%/g,"%25").replace(/\r/g,"%0D").replace(/\n/g,"%0A");
const commandProperty = value => commandText(value).replace(/:/g,"%3A").replace(/,/g,"%2C");
const fail = (message) => { console.log(`::error::${commandText(message)}`); process.exit(1); };
const warn = (message) => { console.log(`::warning::${commandText(message)}`); process.exit(0); };
const output = (name, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`); };
const summary = (markdown) => { if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`); };

// True for a pull request from a fork or from Dependabot, which run without OIDC.
function untrustedPullRequest() {
  if (env("GITHUB_ACTOR") === "dependabot[bot]") return true;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return false;
  try {
    const head = JSON.parse(readFileSync(eventPath, "utf8"))?.pull_request?.head;
    if (!head) return false;
    return head.repo?.full_name !== env("GITHUB_REPOSITORY");
  } catch {
    return false;
  }
}

// Without a token, ask GitHub for an OIDC token that proves which repository this workflow runs in.
async function githubOidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) {
    // GitHub never issues OIDC tokens to pull requests from forks or Dependabot. Skip instead of failing,
    // so a free setup does not put a red check on every outside contributor's pull request.
    if (untrustedPullRequest()) {
      summary("DeployDoctor skipped this pull request: GitHub does not issue OIDC tokens to pull requests from forks or Dependabot. The free scan runs on pull requests from this repository's own branches.");
      warn("DeployDoctor skipped: GitHub does not issue OIDC tokens to pull requests from forks or Dependabot.");
    }
    fail("No `token` given and no GitHub OIDC token available. For a free scan of a public repository add `permissions: id-token: write` (and `contents: read`) to the job, or pass an API token from My scans.");
  }
  const response = await fetch(`${url}&audience=${encodeURIComponent(apiUrl)}`, {
    headers: { authorization: `Bearer ${requestToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) fail(`GitHub did not issue an OIDC token (${response.status}).`);
  const { value } = await response.json();
  if (!value) fail("GitHub returned an empty OIDC token.");
  return value;
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) fail(`Input \`repository\` must be owner/name, got "${repository}".`);
if (!["red", "yellow", "never"].includes(failOn)) fail(`Input \`fail-on\` must be red, yellow or never, got "${failOn}".`);
if (!["true", "false"].includes(failOnHighRisk)) fail(`Input \`fail-on-high-risk\` must be true or false, got "${failOnHighRisk}".`);
const gateHighRisk = failOnHighRisk === "true";

const body = { repoUrl: `https://github.com/${repository}` };
if (ref) body.ref = ref;
// Compare the actual PR merge base, never an arbitrary previous saved report.
const prContext = pullRequestContext();
if (prContext && prContext.repository === repository && prContext.sha === ref.toLowerCase()) body.pullRequest = prContext.number;
if (githubToken) body.privateToken = githubToken;
if (checks.length) body.checks = checks;

async function comment(outcome) {
  if (env("DD_COMMENT", "true") !== "true") return;
  const context = pullRequestContext();
  if (!context || context.repository !== repository || ref.toLowerCase() !== context.sha) { output("comment-status", "skipped"); return; }
  const commentToken = env("DD_COMMENT_TOKEN");
  if (!commentToken) { output("comment-status", "skipped"); return; }
  try {
    const result = await upsertComment({ context, outcome, token: commentToken });
    output("comment-status", result.status);
    if (result.url) output("comment-url", result.url);
    if (result.status === "stale") summary("PR comment kept: the pull request head changed or the PR was closed. This scan is not the current PR result.");
  } catch {
    output("comment-status", "failed");
    console.log("::warning::DeployDoctor could not update the PR comment. Check pull-requests: write permission and comment-token. Scan results remain in the job summary.");
  }
}

const free = !token;
const auth = free ? { "x-github-oidc-token": await githubOidcToken() } : { authorization: `Bearer ${token}` };

let response;
let data;
async function reportScanFailure(message, status) {
  summary("## DeployDoctor: scan failed\n\nNo deploy-risk result was saved for this commit. On a pull request, the sticky comment says the scan failed.");
  await comment({ kind: "unavailable", ...(status ? { status } : {}) });
  if (gateHighRisk) fail(message);
  warn(message);
}
try {
  response = await fetch(`${apiUrl}/api/reports`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": "deploydoctor-action", ...auth },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const raw = await response.text();
  data = raw ? JSON.parse(raw) : {};
} catch (error) {
  if (response) await reportScanFailure(`DeployDoctor returned ${response.status}: the response was not JSON.`, response.status);
  else await reportScanFailure(`DeployDoctor did not answer: ${error instanceof Error ? error.message : String(error)}`);
}

if (free && response.status === 429 && data?.paywall === true) {
  // The free daily quota for this repository is used up: report it, never block the pull request.
  // Any other 429, such as a GitHub API rate limit, is reported as a failed scan below and passes unless fail-on-high-risk is true.
  summary(`## DeployDoctor: not scanned\n\nToday's free scan for ${repository} is used. No new result was produced for this commit. [Pass details](${apiUrl}/pricing).`);
  await comment({kind:"quota"});
  warn(`DeployDoctor: today's free scan for ${repository} is used (${data?.error ?? "daily limit"}). Unlimited scans: ${apiUrl}/pricing`);
}
if (!response.ok) {
  const hint = response.status === 402 ? ` A pass is needed: ${apiUrl}/pricing` : response.status === 401 ? " Create a new token under My scans." : "";
  const detail = typeof data?.error === "string" ? data.error : "unknown error";
  await reportScanFailure(`DeployDoctor returned ${response.status}: ${detail}.${hint}`, response.status);
}

const icon = { red: "🔴", yellow: "🟡", green: "🟢" };
const label = { red: "Fail", yellow: "Review", green: "Pass" };
output("overall", data.overall);
output("report-url", data.url);
output("red", String(data.summary.red));
output("yellow", String(data.summary.yellow));

const rows = data.checks.map((check) => {
  const where = (check.findings ?? []).slice(0, 3).map((finding) => `\`${markdownText(finding.file)}:${finding.line}\``).join(", ");
  return `| ${icon[check.status]} ${label[check.status]} | ${markdownText(check.title)} | ${where || (check.status === "green" ? "" : markdownText(check.explanation))} |`;
});
summary(`## DeployDoctor: ${icon[data.overall]} ${label[data.overall]} on \`${repository}@${(data.ref ?? ref).slice(0, 12)}\`

${data.summary.red} failed, ${data.summary.yellow} to review, ${data.summary.green} passed. [Open the report](${data.url})${data.partial ? " (partial scan, see the report for why)" : ""}.

| Status | Check | Where |
| --- | --- | --- |
${rows.join("\n")}
`);

for (const check of data.checks) {
  if (check.status === "green") continue;
  const findings = check.findings?.length ? check.findings : [{ file: "", line: 0, problem: check.explanation }];
  for (const finding of findings.slice(0, 10)) {
    const status = finding.status === "red" || finding.status === "yellow" ? finding.status : check.status;
    const level = status === "red" ? "error" : "warning";
    const location = finding.file ? `file=${commandProperty(finding.file)},line=${finding.line || 1},` : "";
    console.log(`::${level} ${location}title=${commandProperty(check.title)}::${commandText(finding.problem || check.explanation)} Fix: ${commandText(finding.fix || check.fix)}`);
  }
}

await comment({kind:"report",data,apiUrl});

console.log(`DeployDoctor: ${label[data.overall]} (${data.summary.red} failed, ${data.summary.yellow} to review). ${data.url}`);
const highRisk = data.summary.red > 0;
const needsReview = data.summary.yellow > 0;
const failed = (gateHighRisk && highRisk) || (failOn === "red" && highRisk) || (failOn === "yellow" && (highRisk || needsReview));
if (failed) fail(`DeployDoctor found ${data.summary.red} failed and ${data.summary.yellow} to review. ${data.url}`);
