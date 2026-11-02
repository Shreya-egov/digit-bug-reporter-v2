// Bug tracker rows: one per reported bug. Created when a report is opened on GitHub (or added by issue URL on the
// tracker page), kept after the report's video is pruned, and refreshed from GitHub: issue state, the linked PR,
// its reviewer and its checks. Used by the service worker (periodic sync) and the tracker and review pages.
import * as db from './db.js';
import { getToken, request } from './github-api.js';

export const ENVIRONMENTS = {
  'unified-qa.digit.org': 'qa',
  'unified-uat.digit.org': 'uat',
  'unified-dev.digit.org': 'dev',
  'health-demo.digit.org': 'demo',
  'hcm-demo.digit.org': 'demo',
};
export const TYPES = ['UI', 'API', 'Functional', 'Configuration', 'Performance', 'Other'];
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const TEST_STATUSES = ['Not run', 'Running', 'Passed', 'Failed'];
// Current status, in workflow order (also the order of the tracker's filter and the workbook summary).
export const STATUSES = ['Draft', 'Open', 'In progress', 'In review', 'Fixed', 'Verified', 'Verified & closed', 'Closed (not planned)'];
const FINAL = ['Verified & closed', 'Closed (not planned)'];
const LOG_MAX = 60;

const ISSUE_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/;
const PR_RE = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
export const parseIssueUrl = (url) => { const m = ISSUE_RE.exec(url || ''); return m && { repo: m[1], number: +m[2] }; };
export const parsePrUrl = (url) => { const m = PR_RE.exec(url || ''); return m && { repo: m[1], number: +m[2] }; };

export function fixStatusOf(b) {
  if (b.prState === 'merged') return 'Merged';
  if (b.prState === 'open') return 'PR open';
  if (b.prState === 'closed') return 'PR closed';
  return b.fixStartedAt ? 'In progress' : 'Not started';
}

export function statusOf(b) {
  if (!b.issueUrl) return 'Draft';
  if (b.verifiedAt) return b.issueState === 'closed' ? 'Verified & closed' : 'Verified';
  if (b.prState === 'merged' || (b.issueState === 'closed' && b.issueStateReason !== 'not_planned')) return 'Fixed';
  if (b.issueState === 'closed') return 'Closed (not planned)';
  if (b.prState === 'open') return 'In review';
  if (b.fixStartedAt) return 'In progress';
  return 'Open';
}

// Fixed = the PR was merged or, without a PR, the issue was closed as completed.
export const fixedAtOf = (b) => b.prMergedAt || (b.issueState === 'closed' && b.issueStateReason !== 'not_planned' ? b.closedAt : null) || null;

export const isFinal = (b) => FINAL.includes(statusOf(b));

// Merge a patch into a row and log what changed. Notifies open extension pages so they re-render.
export async function saveBug(id, patch, note) {
  const row = await db.bugs.change(id, (cur) => {
    const now = Date.now();
    const next = { reportedAt: now, log: [], ...cur, ...patch, id, updatedAt: now };
    const log = [...(cur?.log || [])];
    if (note) log.push({ at: now, text: note });
    if (cur && statusOf(cur) !== statusOf(next)) log.push({ at: now, text: `Status: ${statusOf(cur)} → ${statusOf(next)}` });
    if (cur && fixStatusOf(cur) !== fixStatusOf(next)) log.push({ at: now, text: `Fix: ${fixStatusOf(cur)} → ${fixStatusOf(next)}` });
    if (cur && cur.testStatus !== next.testStatus && next.testStatus) log.push({ at: now, text: `Tests: ${next.testStatus}` });
    next.log = log.slice(-LOG_MAX);
    return next;
  });
  chrome.runtime.sendMessage({ type: 'bugs-changed' }).catch(() => {}); // nobody listening is fine
  return row;
}

// For an issue added by URL: the fields this extension and the github-bug skill write into the body.
function fieldsFromBody(body = '') {
  const pick = (re, allowed) => { const v = re.exec(body)?.[1]; return allowed.includes(v) ? v : undefined; };
  const host = /\*\*Environment:\*\*\s*([\w.-]+\.digit\.org)/.exec(body)?.[1];
  const out = {
    env: host && (ENVIRONMENTS[host] || host),
    severity: pick(/\*\*Severity:\*\*\s*(\w+)/, SEVERITIES),
    priority: pick(/\*\*Priority:\*\*\s*(P\d)/, PRIORITIES),
    type: pick(/\*\*Type:\*\*\s*(\w+)/, TYPES),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

// Merged PRs first, then open ones, then the newest.
function bestPr(refs) {
  const rank = (i) => (i.pull_request?.merged_at ? 0 : i.state === 'open' ? 1 : 2);
  return [...refs].sort((a, b) => rank(a) - rank(b) || Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}

function testStatusOf(runs) {
  if (!runs.length) return null;
  if (runs.some((r) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion))) return 'Failed';
  if (runs.some((r) => r.status !== 'completed')) return 'Running';
  return 'Passed';
}

// Read the issue, its linked PR (set by hand, or the PR that mentions the issue) and the PR's checks.
export async function syncBug(b, token) {
  const issue = parseIssueUrl(b.issueUrl);
  if (!issue) return b;
  const { data: i } = await request(`/repos/${issue.repo}/issues/${issue.number}`, token);
  const patch = {
    title: i.title,
    issueState: i.state,
    issueStateReason: i.state_reason || null,
    closedAt: i.closed_at ? Date.parse(i.closed_at) : null,
    assignees: i.assignees.map((a) => a.login),
    labels: i.labels.map((l) => l.name),
    lastSyncAt: Date.now(),
    lastSyncError: null,
  };
  if (b.imported && !b.filledFromIssue) {
    Object.assign(patch, { reportedAt: Date.parse(i.created_at), repo: b.repo || issue.repo, filledFromIssue: true });
    for (const [k, v] of Object.entries(fieldsFromBody(i.body || ''))) if (!b[k]) patch[k] = v;
  }

  let pr = parsePrUrl(b.prUrl);
  if (!b.prSetByHand) {
    const { data: timeline } = await request(`/repos/${issue.repo}/issues/${issue.number}/timeline?per_page=100`, token);
    const refs = timeline.filter((e) => e.event === 'cross-referenced' && e.source?.issue?.pull_request).map((e) => e.source.issue);
    const found = refs.length && bestPr(refs);
    if (found) pr = parsePrUrl(found.html_url);
  }
  if (pr) {
    const { data: p } = await request(`/repos/${pr.repo}/pulls/${pr.number}`, token);
    const reviewers = p.requested_reviewers.map((r) => r.login);
    Object.assign(patch, {
      prUrl: p.html_url,
      prState: p.merged_at ? 'merged' : p.state,
      prMergedAt: p.merged_at ? Date.parse(p.merged_at) : null,
      // GitHub drops a reviewer from the requested list once they review, so keep the last one known
      reviewer: reviewers.join(', ') || b.reviewer || '',
    });
    const { data: checks } = await request(`/repos/${pr.repo}/commits/${p.head.sha}/check-runs?per_page=100`, token);
    const tests = testStatusOf(checks.check_runs);
    if (tests) patch.testStatus = tests;
  }
  return saveBug(b.id, patch);
}

// Refresh every row that can still change. Stops at the first rate-limit or auth error, which would repeat.
export async function syncAll() {
  const token = await getToken();
  const rows = (await db.bugs.all()).filter((b) => b.issueUrl && !isFinal(b));
  let synced = 0;
  let error = null;
  for (const b of rows) {
    try {
      await syncBug(b, token);
      synced++;
    } catch (err) {
      error = err.message;
      await saveBug(b.id, { lastSyncError: error });
      if (/limit|token/i.test(error)) break;
    }
  }
  const result = { at: Date.now(), synced, total: rows.length, error };
  await db.meta.set('lastSync', result);
  chrome.runtime.sendMessage({ type: 'bugs-changed' }).catch(() => {});
  return result;
}
