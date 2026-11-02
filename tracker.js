import * as db from './db.js';
import {
  PRIORITIES, SEVERITIES, STATUSES, TEST_STATUSES, TYPES,
  fixStatusOf, fixedAtOf, isFinal, parseIssueUrl, parsePrUrl, saveBug, statusOf, syncBug,
} from './bugs.js';
import { getToken, listAssignees, listRepos } from './github-api.js';
import { buildWorkbook, linkWorkbook, linkedHandle, unlinkWorkbook, writeLinked } from './workbook.js';

const $ = (id) => document.getElementById(id);
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const BRANCH_RE = /^[\w./-]+$/;
const UI_REPO = 'egovernments/DIGIT-Frontend';

let rows = [];

// Small DOM helper; text always goes in as text nodes, never as HTML (titles come from GitHub).
function h(tag, props = {}, ...children) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}
const ext = (href, text) => h('a', { href, textContent: text, target: '_blank', rel: 'noopener' });
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
const time = (ms) => new Date(ms).toLocaleString();
const fillSelect = (select, values, selected) => select.replaceChildren(
  ...values.map((v) => h('option', { value: v, textContent: v, selected: v === selected })));
const issueLabel = (b) => { const i = parseIssueUrl(b.issueUrl); return i ? `${i.repo.split('/')[1]}#${i.number}` : 'draft'; };

// ---- summary ----
function renderSummary() {
  const count = (fn) => rows.filter(fn).length;
  const st = (s) => count((b) => statusOf(b) === s);
  const tiles = [
    ['Total reported', rows.length],
    ['Open', st('Open')],
    ['In progress', st('In progress') + st('In review')],
    ['Fixed, not verified', st('Fixed')],
    ['Verified & closed', st('Verified & closed')],
    ['PRs awaiting review', count((b) => fixStatusOf(b) === 'PR open')],
  ];
  $('tiles').replaceChildren(...tiles.map(([label, n]) => h('li', {}, h('span', { className: 'n', textContent: n }), h('span', { textContent: label }))));

  const table = (title, values) => {
    const counts = new Map();
    for (const b of rows) for (const v of values(b)) counts.set(v, (counts.get(v) || 0) + 1);
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    return h('table', { className: 'mini' },
      h('caption', { className: 'visually-hidden', textContent: title }),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', textContent: title.replace(/^By (\w)/, (_, c) => c.toUpperCase()) }), h('th', { scope: 'col', textContent: 'Bugs' }))),
      h('tbody', {}, sorted.length ? sorted.map(([v, n]) => h('tr', {}, h('td', { textContent: v }), h('td', { textContent: n })))
        : h('tr', {}, h('td', { colSpan: 2, textContent: 'None yet' }))));
  };
  $('breakdownTables').replaceChildren(
    table('By repository', (b) => [b.repo || '(not set)']),
    table('By environment', (b) => [b.env || '(not set)']),
    table('By severity', (b) => [b.severity || '(not set)']),
    table('By owner', (b) => (b.assignees?.length ? b.assignees : ['(unassigned)'])),
  );
}

// ---- table ----
function matches(b) {
  const f = $('statusFilter').value;
  if (f === 'active' && isFinal(b)) return false;
  if (f !== 'active' && f !== 'all' && statusOf(b) !== f) return false;
  const q = $('search').value.trim().toLowerCase();
  if (!q) return true;
  return [b.title, b.repo, b.env, issueLabel(b), b.reviewer, ...(b.assignees || [])].join(' ').toLowerCase().includes(q);
}

function renderRows() {
  const shown = rows.filter(matches);
  $('empty').hidden = rows.length > 0;
  $('rows').replaceChildren(...shown.map((b) => {
    const pr = parsePrUrl(b.prUrl);
    const status = statusOf(b);
    return h('tr', {},
      h('td', {}, b.issueUrl ? ext(b.issueUrl, issueLabel(b)) : 'draft'),
      h('td', { className: 'title' }, b.title || '(no title)', b.lastSyncError ? h('span', { className: 'sync-error', title: b.lastSyncError, textContent: ' ⚠' }) : null),
      h('td', { textContent: b.env || '' }),
      h('td', { textContent: (b.repo || '').replace(/^egovernments\//, '') }),
      h('td', { textContent: b.type || '' }),
      h('td', { textContent: b.severity || '' }),
      h('td', { textContent: b.priority || '' }),
      h('td', { textContent: (b.assignees || []).join(', ') }),
      h('td', { textContent: fixStatusOf(b) }),
      h('td', {}, pr ? ext(b.prUrl, `#${pr.number}`) : ''),
      h('td', { textContent: b.testStatus || 'Not run' }),
      h('td', { textContent: day(b.reportedAt) }),
      h('td', {}, h('span', { className: `status s-${status.replace(/\W+/g, '-').toLowerCase()}`, textContent: status })),
      h('td', {}, h('button', { type: 'button', textContent: 'Open', onclick: () => openBug(b.id), ariaLabel: `Open ${b.title || issueLabel(b)}` })),
    );
  }));
}

async function load() {
  rows = (await db.bugs.all()).sort((a, b) => (b.reportedAt || 0) - (a.reportedAt || 0));
  renderSummary();
  renderRows();
  const last = await db.meta.get('lastSync');
  $('syncStatus').textContent = last
    ? `Last sync ${time(last.at)}: ${last.synced} of ${last.total} refreshed${last.error ? `. Problem: ${last.error}` : '.'}`
    : 'Not synced yet.';
  scheduleWorkbookWrite(); // also after this page's own edits: a page doesn't receive its own runtime messages
}

// ---- linked workbook ----
let writeTimer;
function scheduleWorkbookWrite() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => updateWorkbook(false), 800);
}

async function updateWorkbook(ask) {
  try {
    const result = await writeLinked(rows, ask);
    await showWorkbookStatus(result === 'needs-permission');
  } catch (err) {
    $('workbookStatus').textContent = `Couldn't write the workbook (${err.message}). If it's open in Excel, close it and press Update workbook.`;
    $('relink').hidden = false;
  }
}

async function showWorkbookStatus(needsPermission = false) {
  const handle = await linkedHandle();
  $('link').textContent = handle ? 'Link a different file…' : 'Link a workbook file…';
  $('unlink').hidden = !handle;
  $('relink').hidden = !handle || !needsPermission;
  if (!handle) {
    $('workbookStatus').textContent = 'No workbook linked. Link one (e.g. in a shared OneDrive or Drive folder) to keep it updated automatically while this page is open.';
    return;
  }
  const at = await db.meta.get('workbookWrittenAt');
  $('workbookStatus').textContent = needsPermission
    ? `Linked to ${handle.name}. Chrome needs your OK to write it again: press Update workbook.`
    : `Linked to ${handle.name}${at ? `, last written ${time(at)}` : ''}. It is rewritten whenever the tracker changes while this page is open.`;
}

$('link').addEventListener('click', async () => {
  try {
    await linkWorkbook();
    await updateWorkbook(true);
  } catch (err) {
    if (err.name !== 'AbortError') $('workbookStatus').textContent = `Couldn't link the file: ${err.message}`;
  }
});
$('relink').addEventListener('click', () => updateWorkbook(true));
$('unlink').addEventListener('click', async () => { await unlinkWorkbook(); await showWorkbookStatus(); });

$('export').addEventListener('click', () => {
  const a = h('a', { href: URL.createObjectURL(buildWorkbook(rows)), download: `DIGIT-HCM-bug-tracker-${day(Date.now())}.xlsx` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

// ---- sync ----
$('sync').addEventListener('click', async () => {
  $('sync').disabled = true;
  $('syncStatus').textContent = 'Syncing with GitHub…';
  const res = await chrome.runtime.sendMessage({ type: 'sync-bugs' });
  $('sync').disabled = false;
  if (!res?.ok) $('syncStatus').textContent = `Sync failed: ${res?.error}`;
  await load();
});

// ---- dialogs ----
for (const btn of document.querySelectorAll('dialog .close')) btn.addEventListener('click', () => btn.closest('dialog').close());

function showError(id, text) {
  $(id).hidden = !text;
  $(id).textContent = text || '';
}

$('addIssue').addEventListener('click', () => {
  $('addUrl').value = '';
  showError('addError', '');
  $('addDialog').showModal();
});

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $('addUrl').value.trim().replace(/[#?].*$/, '');
  const issue = parseIssueUrl(url);
  if (!issue) return showError('addError', 'Paste a link like https://github.com/owner/repo/issues/123.');
  if (rows.some((b) => b.issueUrl === url)) return showError('addError', 'That issue is already in the tracker.');
  showError('addError', '');
  const bug = await saveBug(crypto.randomUUID(), { issueUrl: url, repo: issue.repo, imported: true }, 'Added by URL');
  try {
    await syncBug(bug, await getToken());
  } catch (err) {
    await saveBug(bug.id, { lastSyncError: err.message });
  }
  $('addDialog').close();
  await load();
});

let current = null;

async function openBug(id) {
  current = await db.bugs.get(id);
  if (!current) return;
  const b = current;
  $('bugTitle').textContent = b.title || '(no title)';
  const pr = parsePrUrl(b.prUrl);
  $('bugLinks').replaceChildren(
    b.issueUrl ? ext(b.issueUrl, issueLabel(b)) : 'Not on GitHub yet',
    pr ? ' · ' : '', pr ? ext(b.prUrl, `PR #${pr.number}`) : '',
    ` · ${statusOf(b)} · fix: ${fixStatusOf(b)}`,
    fixedAtOf(b) ? ` · fixed ${day(fixedAtOf(b))}` : '',
    b.verifiedAt ? ` · verified ${day(b.verifiedAt)}` : '',
    b.lastSyncError ? ` · last sync failed: ${b.lastSyncError}` : '',
  );
  fillSelect($('bType'), ['', ...TYPES], b.type || '');
  fillSelect($('bSeverity'), ['', ...SEVERITIES], b.severity || '');
  fillSelect($('bPriority'), ['', ...PRIORITIES], b.priority || '');
  fillSelect($('bTests'), TEST_STATUSES, b.testStatus || 'Not run');
  $('bEnv').value = b.env || '';
  $('bReviewer').value = b.reviewer || '';
  $('bPr').value = b.prSetByHand ? b.prUrl : '';
  $('bConfig').value = b.configFix || '';
  $('bConfigFixed').textContent = b.configFixedAt ? 'Clear "fixed by MDMS change"' : 'Mark fixed by MDMS change';
  $('bConfigFixed').disabled = !b.issueUrl;
  $('bPr').placeholder = !b.prSetByHand && b.prUrl ? `${b.prUrl} (found on GitHub)` : 'https://github.com/egovernments/DIGIT-Frontend/pull/1234';
  $('bFix').disabled = !b.issueUrl;
  $('bFix').title = b.issueUrl ? '' : 'Open the issue on GitHub first';
  $('bStarted').textContent = b.fixStartedAt ? 'Clear "fix in progress"' : 'Mark fix in progress';
  $('bVerified').textContent = b.verifiedAt ? 'Clear verified' : 'Mark verified';
  $('bVerified').disabled = !b.verifiedAt && statusOf(b) !== 'Fixed';
  $('bVerified').title = $('bVerified').disabled ? 'A bug can be verified once its fix is merged or the issue is closed as completed' : '';
  $('bLog').replaceChildren(...[...(b.log || [])].reverse().map((l) => h('li', {}, h('time', { textContent: time(l.at) }), ` ${l.text}`)));
  showError('bugError', '');
  if (!$('bugDialog').open) $('bugDialog').showModal();
}

async function change(patch, note) {
  current = await saveBug(current.id, patch, note);
  await load();
  await openBug(current.id);
}

$('bugForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prUrl = $('bPr').value.trim();
  if (prUrl && !parsePrUrl(prUrl)) return showError('bugError', 'The PR URL should look like https://github.com/owner/repo/pull/123.');
  const reviewer = $('bReviewer').value.trim().replace(/^@/, '');
  if (reviewer && !reviewer.split(/[\s,]+/).every((l) => LOGIN_RE.test(l))) return showError('bugError', 'Reviewer should be GitHub usernames.');
  const patch = {
    type: $('bType').value, severity: $('bSeverity').value, priority: $('bPriority').value,
    env: $('bEnv').value.trim(), reviewer, testStatus: $('bTests').value, configFix: $('bConfig').value.trim(),
  };
  if (prUrl) Object.assign(patch, { prUrl, prSetByHand: true });
  else if (current.prSetByHand) Object.assign(patch, { prUrl: null, prState: null, prMergedAt: null, prSetByHand: false });
  await change(patch, 'Edited in the tracker');
  if (current.issueUrl && (prUrl || patch.prSetByHand === false)) {
    await syncBug(current, await getToken()).catch((err) => saveBug(current.id, { lastSyncError: err.message }));
    await load();
    await openBug(current.id);
  }
  $('bugDialog').close();
});

$('bConfigFixed').addEventListener('click', () => {
  if (current.configFixedAt) return change({ configFixedAt: null }, 'Fixed by MDMS change: cleared');
  const what = $('bConfig').value.trim();
  if (!what) {
    showError('bugError', 'Say what was changed in MDMS first (env, schema, record, change), so the fix can be traced and undone.');
    $('bConfig').focus();
    return;
  }
  return change({ configFixedAt: Date.now(), configFix: what }, `Fixed by MDMS change: ${what}`);
});

$('bStarted').addEventListener('click', () => change(
  { fixStartedAt: current.fixStartedAt ? null : Date.now() },
  current.fixStartedAt ? 'Fix in progress cleared' : 'Fix marked in progress'));

$('bVerified').addEventListener('click', () => change(
  { verifiedAt: current.verifiedAt ? null : Date.now() },
  current.verifiedAt ? 'Verification cleared' : 'Verified by QA'));

$('bDelete').addEventListener('click', async () => {
  if (!confirm(`Remove "${current.title || issueLabel(current)}" from the tracker? The GitHub issue is not touched.`)) return;
  await db.bugs.remove(current.id);
  $('bugDialog').close();
  await load();
});

// ---- fix UI issue: repo and reviewer here, the rest in Claude Code ----
let reviewerLoad = 0;

async function loadReviewers() {
  const repo = $('fixRepo').value.trim();
  const select = $('fixReviewer');
  if (!REPO_RE.test(repo)) { fillSelect(select, [''], ''); return; }
  const load = ++reviewerLoad;
  $('fixReviewerHint').textContent = 'Loading people…';
  try {
    const logins = await listAssignees(repo, await getToken());
    if (load !== reviewerLoad) return;
    const keep = current.reviewer?.split(/[\s,]+/)[0] || current.assignees?.[0] || '';
    fillSelect(select, ['', ...logins], logins.includes(keep) ? keep : '');
    select.options[0].textContent = '(none: assign later on GitHub)';
    $('fixReviewerHint').textContent = '';
  } catch (err) {
    if (load !== reviewerLoad) return;
    fillSelect(select, [''], '');
    select.options[0].textContent = '(couldn\'t list people)';
    $('fixReviewerHint').textContent = `Couldn't list people (${err.message}). Name the reviewer when Claude asks.`;
  }
  renderCommand();
}

function fixCommand() {
  const repo = $('fixRepo').value.trim();
  const reviewer = $('fixReviewer').value;
  const base = $('fixBase').value.trim();
  const args = [current.issueUrl, `repo=${repo}`, reviewer && `reviewer=${reviewer}`, base && `base=${base}`].filter(Boolean);
  // values are validated against strict patterns, so double quotes are safe in any shell
  return `claude --chrome "/fix-ui-bug ${args.join(' ')}"`;
}

function fixProblem() {
  if (!REPO_RE.test($('fixRepo').value.trim())) return 'Pick a repository in the form owner/name.';
  const base = $('fixBase').value.trim();
  if (base && !BRANCH_RE.test(base)) return 'Branch names can only contain letters, numbers, ., _, / and -.';
  return '';
}

function renderCommand() {
  const problem = fixProblem();
  showError('fixError', problem);
  $('fixCommand').textContent = problem ? '' : fixCommand();
}

$('bFix').addEventListener('click', async () => {
  $('fixIssue').replaceChildren(ext(current.issueUrl, issueLabel(current)), ` · ${current.title || ''}`);
  // UI fixes usually land in DIGIT-Frontend even when the issue was filed against the services repo
  $('fixRepo').value = current.fixRepo || (current.type === 'UI' || !current.repo ? UI_REPO : current.repo);
  $('fixBase').value = current.fixBase || '';
  fillSelect($('fixReviewer'), [''], '');
  $('fixDialog').showModal();
  renderCommand();
  loadReviewers();
  listRepos(await getToken()).then((repos) => {
    $('repoList').replaceChildren(...[...new Set([UI_REPO, ...repos])].map((r) => h('option', { value: r })));
  }, () => {});
});

$('fixRepo').addEventListener('change', loadReviewers);
for (const id of ['fixRepo', 'fixBase', 'fixReviewer']) $(id).addEventListener('input', renderCommand);

$('fixForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (fixProblem()) return renderCommand();
  const command = fixCommand();
  await navigator.clipboard.writeText(command);
  const reviewer = $('fixReviewer').value;
  await change({
    fixRepo: $('fixRepo').value.trim(), fixBase: $('fixBase').value.trim(),
    fixStartedAt: current.fixStartedAt || Date.now(), ...(reviewer && { reviewer }),
  }, `Fix handed to Claude Code: ${command}`);
  $('fixDialog').close();
  $('syncStatus').textContent = 'Command copied. Paste it into a terminal in any folder; Claude finds the local clone.';
});

// ---- filters, live updates ----
fillSelect($('statusFilter'), ['active', 'all', ...STATUSES], 'active');
$('statusFilter').options[0].textContent = 'Not yet verified/closed';
$('statusFilter').options[1].textContent = 'All';
$('statusFilter').addEventListener('change', renderRows);
$('search').addEventListener('input', renderRows);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'bugs-changed') return;
  load();
});

await showWorkbookStatus();
await load();
