import { readFileSync } from 'node:fs';
export const MARKER = '<!-- deploydoctor:pr-report:v1 -->';
const SHA = /^[a-f0-9]{40}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Escape source-controlled text so it cannot add Markdown links, HTML or GitHub mentions. */
export function text(value, max = 350) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, max)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#!|~]/g, '\\$&').replace(/@/g, '&#64;');
}
export function reportUrl(value, apiUrl) {
  try { const u = new URL(value), base = new URL(apiUrl); return u.protocol === 'https:' && u.origin === base.origin && !u.username && !u.password && !u.search && !u.hash && /^\/r\/[A-Za-z0-9-]+$/.test(u.pathname) ? u.href : null; } catch { return null; }
}
export function pullRequestContext(env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || env.GITHUB_ACTOR === 'dependabot[bot]' || !REPO.test(env.GITHUB_REPOSITORY ?? '')) return null;
  try {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')), pr = event.pull_request;
    if (!Number.isSafeInteger(event.number) || event.number < 1 || pr?.base?.repo?.full_name !== env.GITHUB_REPOSITORY || pr?.head?.repo?.full_name !== env.GITHUB_REPOSITORY || !SHA.test(pr?.head?.sha ?? '')) return null;
    return { repository: env.GITHUB_REPOSITORY, number: event.number, sha: pr.head.sha.toLowerCase() };
  } catch { return null; }
}
function sourceLocation(repository, sha, finding) {
  const file = String(finding.file ?? ''), line = Number(finding.line);
  const label = text(file ? `${file}:${Number.isSafeInteger(line) && line > 0 ? line : 1}` : 'Configuration');
  if (!file || file.startsWith('/') || /[\\\r\n\0]/.test(file) || file.split('/').some(p => !p || p === '.' || p === '..') || !Number.isSafeInteger(line) || line < 1 || line > 1_000_000) return label;
  return `[${label}](https://github.com/${repository}/blob/${sha}/${file.split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16))).join('/')}#L${line})`;
}
const footer = audit => `\n\nStatic source analysis only. Builds, runtime behavior and payment fulfillment were not executed.${audit ? '\n\n<sub>Need a human review? [One-repo audit · €149](https://deploydoctor.nyttolabs.com/?utm_source=github-action&utm_medium=pr-comment#human-audit-heading).</sub>' : ''}`;
function changeReview(context, impact) {
  if (impact == null) return '';
  if (impact.version !== 1 || impact.number !== context.number || impact.headCommitSha !== context.sha || !SHA.test(impact.baseCommitSha ?? '')
    || ['introduced','persisting','noLongerDetected','uncertain','notCompared'].some(key => !Array.isArray(impact[key]))) throw new Error('PR comparison does not match this PR.');
  const list = impact.introduced.slice(0,3).map(f => `- **${f.status === 'red' ? 'Source finding' : 'Needs review'}** · ${sourceLocation(context.repository, context.sha, f)}\n  ${text(f.problem)}\n  Next step: ${text(f.fix)}`).join('\n\n');
  return `\n\n### What changed in this PR?\n\nCompared with merge base [${impact.baseCommitSha.slice(0,12)}](https://github.com/${context.repository}/commit/${impact.baseCommitSha}).\n\n**${impact.introduced.length} newly detected** · ${impact.persisting.length} already present · ${impact.noLongerDetected.length} no longer detected.${impact.partial || impact.notCompared.length || impact.uncertain.length ? '\n\n**Incomplete comparison:** unmatched findings require review, not a new/fixed verdict.' : ''}\n\n${list || 'No newly detected findings in comparable checks. This does not establish that the PR is safe to merge.'}${impact.introduced.length > 3 ? `\n\n${impact.introduced.length - 3} more newly detected findings in the report.` : ''}\n\nNo longer detected is not a verified fix. This compares source snapshots, not the merged build.`;
}
export function renderComment(context, outcome, audit = true) {
  const heading = `${MARKER}\n## DeployDoctor · `;
  const commit = `Analyzed commit: [${context.sha.slice(0, 12)}](https://github.com/${context.repository}/commit/${context.sha}).`;
  if (outcome.kind !== 'report') return `${heading}Not scanned\n\nRequested commit: [${context.sha.slice(0,12)}](https://github.com/${context.repository}/commit/${context.sha}).\n\n${outcome.kind === 'quota' ? 'The free daily allowance for this repository is used. No new scan was performed for this commit. [Continue with an existing pass](https://deploydoctor.nyttolabs.com/pricing).' : 'The latest scan could not finish. Check the workflow job for the error and retry. No result is available for this commit.'}\n\nThis replaces the previous comment; a previous pass is not a result for this commit.${footer(audit)}`;
  const data = outcome.data, url = reportUrl(data.url, outcome.apiUrl);
  if (!url || !SHA.test(data.commitSha ?? '') || data.commitSha.toLowerCase() !== context.sha || data.repoUrl !== `https://github.com/${context.repository}`) throw new Error('Report does not match this PR commit/repository.');
  if (!['red','yellow','green'].includes(data.overall) || !Array.isArray(data.checks) || !data.summary || ['red','yellow','green'].some(k => !Number.isSafeInteger(data.summary[k]) || data.summary[k] < 0)) throw new Error('Invalid scan result.');
  const changes = changeReview(context, data.pullRequest);
  if (changes) return `${heading}PR change review\n\n${commit}${changes}\n\nFull head scan: ${data.summary.red} red checks · ${data.summary.yellow} to review · ${data.summary.green} passed.${data.partial ? ' Partial source coverage.' : ''}\n\n[Open full report](${url})${data.isPrivate ? ' · Private report: existing owner authentication is required.' : ''}${footer(audit)}`;
  const findings = data.checks.filter(c => c.status !== 'green').flatMap(c => (c.findings?.length ? c.findings : [{ problem: c.explanation, fix: c.fix }]).map(f => ({ ...f, status: ['red','yellow'].includes(f.status) ? f.status : c.status })));
  findings.sort((a,b) => (a.status === 'red' ? 0 : 1) - (b.status === 'red' ? 0 : 1));
  const list = findings.slice(0,3).map(f => `- **${f.status === 'red' ? 'Source finding' : 'Needs review'}** · ${sourceLocation(context.repository,context.sha,f)}\n  ${text(f.problem)}\n  Next step: ${text(f.fix)}`).join('\n\n');
  return `${heading}${data.partial ? 'Partial scan' : data.overall === 'red' ? 'Source findings' : data.overall === 'yellow' ? 'Needs review' : 'Checks passed'}\n\n${commit}\n\nRed checks: ${data.summary.red} · To review: ${data.summary.yellow} · Passed: ${data.summary.green}.${data.partial ? '\n\n**Partial coverage:** some source was not checked. A clean result for unread files cannot be established.' : ''}\n\n${list || 'No matching findings in the checks performed. This is not a guarantee that deployment will succeed.'}${findings.length > 3 ? `\n\n${findings.length - 3} more findings in the full report.` : ''}\n\n[Open full report](${url})${data.isPrivate ? ' · Private report: existing owner authentication is required.' : ''}${footer(audit)}`;
}
/** GitHub token stays in the runner. Fixed API origin; no redirects or source execution. */
export async function upsertComment({ context, outcome, token, audit = true, fetcher = fetch }) {
  const body = renderComment(context,outcome,audit);
  const api = async (path, method = 'GET', data) => {
    const response = await fetcher(`https://api.github.com/repos/${context.repository}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type':'application/json', accept: 'application/vnd.github+json', 'X-GitHub-Api-Version':'2026-03-10' }, ...(data ? { body:JSON.stringify(data) } : {}), redirect:'error',signal:AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`GitHub comment request returned ${response.status}. Check pull-requests: write permission.`);
    const raw = await response.text();if(raw.length > 2_000_000)throw new Error('GitHub comment response too large.');return raw ? JSON.parse(raw) : null;
  };
  const current = async () => {
    const pr = await api(`/pulls/${context.number}`);
    return pr.state === 'open' && pr.base?.repo?.full_name === context.repository && pr.head?.repo?.full_name === context.repository && pr.head?.sha?.toLowerCase() === context.sha;
  };
  if (!await current()) return {status:'stale'};
  let existing;
  for (let page=1;page<=10;page++) {
    const comments=await api(`/issues/${context.number}/comments?per_page=100&page=${page}`);
    if(!Array.isArray(comments))throw new Error('Invalid comments response.');
    existing=comments.find(c => Number.isSafeInteger(c.id) && c.id > 0 && c.user?.type === 'Bot' && c.user?.login === 'github-actions[bot]' && typeof c.body === 'string' && c.body.startsWith(MARKER));
    if(existing || comments.length < 100)break;
    if(page===10)throw new Error('Too many comments to find the existing report safely.');
  }
  // Recheck after pagination: an older run must not overwrite the status of a newer push.
  if(!await current())return {status:'stale'};
  const result=await api(existing ? `/issues/comments/${existing.id}` : `/issues/${context.number}/comments`, existing ? 'PATCH' : 'POST', {body});
  const prefix=`https://github.com/${context.repository}/pull/${context.number}#issuecomment-`;
  const url=typeof result?.html_url === 'string' && result.html_url.startsWith(prefix) && /^\d+$/.test(result.html_url.slice(prefix.length)) ? result.html_url : undefined;
  return {status:existing?'updated':'created',url};
}
