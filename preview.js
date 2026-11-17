import * as db from './db.js';
import { redact } from './redact.js';
import { getToken, listAssignees, listLabels, listRepos } from './github-api.js';
import { createCombo } from './combo.js';
import { createChipPicker } from './chips.js';
import { ENVIRONMENTS, PRIORITIES, SEVERITIES, TYPES, saveBug } from './bugs.js';

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');

const UI_REPO = 'egovernments/DIGIT-Frontend';
const SERVICE_REPO = 'egovernments/health-campaign-services';
const MAX_STEPS = 25;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

const counts = {};
const clean = (s) => redact(s, counts).text;

const OS_NAMES = { linux: 'Linux', mac: 'macOS', win: 'Windows', cros: 'ChromeOS', android: 'Android' };

const envName = (url) => { try { return ENVIRONMENTS[new URL(url).host] || new URL(url).host; } catch { return ''; } };

// info: read from the page and the browser when capture finished (background.js pageInfo)
function environmentLine(url, events, info = {}) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const env = ENVIRONMENTS[u.host];
  const tenant = info.tenant || [...events].reverse().find((e) => e.kind === 'meta')?.tenant;
  const campaign = u.searchParams.get('campaignNumber');
  const flow = u.searchParams.get('flow');
  const chrome = navigator.userAgent.match(/Chrome\/(\d+)/)?.[1];
  const os = info.os && `${OS_NAMES[info.os] || info.os}${info.arch ? ` ${info.arch}` : ''}`;
  const parts = [
    `${u.host}${env ? ` (${env})` : ''}`,
    tenant && `tenant ${tenant}`,
    campaign && `campaign ${campaign}${flow ? ` / flow ${flow}` : ''}`,
    chrome && `Chrome ${chrome}${os ? ` on ${os}` : ''}`,
  ];
  if (info.build) parts.push(`UI build: ${info.build}`);
  return parts.filter(Boolean).join(', ');
}

function draftSteps(url, events) {
  const steps = [];
  let first;
  try { first = new URL(url); } catch { /* no url */ }
  const firstNav = events.find((e) => e.kind === 'nav');
  const start = firstNav?.url || (first ? first.pathname + first.search : '');
  if (first) steps.push(`Open https://${first.host}${start}`);
  const repeats = [1];
  for (const e of events) {
    let text;
    if (e.kind === 'action') text = e.text;
    else if (e.kind === 'nav' && e !== firstNav) text = `Page changes to ${e.url}`;
    if (!text) continue;
    // repeated clicks (e.g. "Next" through a wizard) are real steps, so count them rather than drop them
    if (text === steps[steps.length - 1]) repeats[repeats.length - 1]++;
    else { steps.push(text); repeats.push(1); }
  }
  const lines = steps.map((s, i) => (repeats[i] > 1 ? `${s} (×${repeats[i]})` : s));
  const shown = lines.slice(0, MAX_STEPS);
  if (lines.length > MAX_STEPS) shown.push(`… ${lines.length - MAX_STEPS} more actions not listed`);
  return shown.map((s, i) => `${i + 1}. ${s}`).join('\n');
}

// Collapse repeats so a retry loop doesn't fill the ticket.
function dedupe(lines) {
  const seen = new Map();
  for (const l of lines) seen.set(l, (seen.get(l) || 0) + 1);
  return [...seen].map(([l, n]) => (n > 1 ? `${l}  (×${n})` : l));
}

function evidenceText(events) {
  const errors = dedupe(events.filter((e) => e.kind === 'console').map((e) => e.text));
  return errors.length ? 'Console errors:\n' + errors.slice(0, 20).join('\n') : 'No console errors were captured.';
}

// ---- API calls: every call is listed; the ticked ones go into the issue with a curl and their response ----
const BODY_LIMIT = 65_536; // GitHub rejects longer issue bodies
const isFailed = (e) => !e.status || e.status >= 400;
const TRUNCATED = '\n… (truncated';
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const parseJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

// page-hook.js keeps same-origin URLs as a path and other hosts as host + path
function fullUrl(url, origin) {
  if (/^https?:\/\//.test(url)) return url;
  return url.startsWith('/') ? `${origin}${url}` : `https://${url}`;
}

function curlOf(call, origin) {
  const lines = [`curl -sS -X ${call.method} ${shellQuote(fullUrl(call.url, origin))}`];
  const note = [];
  // redact() masks the token placeholder page-hook.js put in RequestInfo; put the placeholder back for the reader
  const body = (call.body || '').replace(/("authToken"\s*:\s*)"<redacted>"/gi, '$1"<your-auth-token>"');
  if (/^<[^>]*>$/.test(body)) note.push(`# request body: ${body}`);
  else if (body) {
    if (body.includes(TRUNCATED)) note.push('# the request body was truncated when recorded; complete it before running');
    if (parseJson(body) !== undefined) lines.push(`-H 'Content-Type: application/json'`);
    lines.push(`--data-raw ${shellQuote(body)}`);
  }
  if (body.includes('<your-auth-token>')) note.push('# replace <your-auth-token> with your own token (localStorage "Employee.token" on the DIGIT page)');
  return [...note, lines.join(' \\\n  ')].join('\n');
}

function fence(text, lang = '') {
  const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map((m) => m.length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

function responseBlock(call) {
  const text = (call.response || '').trim();
  if (!text) return '_empty response_';
  const json = parseJson(text);
  return json !== undefined ? fence(JSON.stringify(json, null, 2), 'json') : fence(text, 'text');
}

const callTitle = (c) => `${c.method} ${c.url} → ${c.status || 'failed'}${c.ms != null ? ` · ${c.ms} ms` : ''}`;

function apiMarkdown(calls, origin) {
  if (!calls.length) return '';
  const blocks = calls.map((c) => [
    `<details${isFailed(c) ? ' open' : ''}><summary><code>${escapeHtml(callTitle(c))}</code>${c.error ? ` ${escapeHtml(c.error)}` : ''}</summary>`,
    '',
    fence(curlOf(c, origin), 'bash'),
    '',
    'Response:',
    '',
    responseBlock(c),
    '',
    '</details>',
  ].join('\n'));
  return `**API calls** (${calls.length}):\n\n${blocks.join('\n\n')}\n\n`;
}

// A failing HCM service call points at the backend; everything else is UI behaviour.
function suggestRepo(events) {
  const svc = events.find((e) => e.kind === 'network' && e.status >= 500 && /\/_(search|create|update|delete)|\/v\d\//.test(e.url));
  return svc
    ? [SERVICE_REPO, `Suggested because ${svc.method} ${svc.url.split('?')[0]} returned ${svc.status}.`, 'API']
    : [UI_REPO, 'Suggested because no HCM service returned a 5xx error. Change it if the data saved is wrong.', 'UI'];
}

function fillSelect(select, values, selected) {
  select.replaceChildren(...values.map((v) => Object.assign(document.createElement('option'), { textContent: v, selected: v === selected })));
}

function componentOf(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; }
}

function buildBody() {
  const v = (k) => $(k).value.trim();
  const section = (h, text) => `## ${h}\n${text || '_not provided_'}\n`;
  const media = [$('includeShot').checked && report.screenshot && 'screenshot', $('includeVideo').checked && report.video?.size && 'screen recording']
    .filter(Boolean).join(' and ');
  return [
    `**Environment:** ${v('env')}\n`,
    section('Summary', v('summary')),
    section('Preconditions', v('preconditions')),
    section('Steps to reproduce', v('steps')),
    section('Expected', v('expected')),
    section('Actual', v('actual')),
    section('Evidence', `${media ? `The ${media} ${media.includes(' and ') ? 'are' : 'is'} attached below.\n\n` : ''}`
      + `${apiMarkdown(pickedCalls(), origin)}${fence(v('evidence'), 'text')}`),
    section('Notes', v('notes')),
    `**Severity:** ${v('severity')}   **Priority:** ${v('priority')}   **Type:** ${v('type')}   **Component:** ${v('component') || 'not set'}`,
    '',
    '<sub>Captured with DIGIT Bug Reporter v2. Evidence was redacted automatically and reviewed by the reporter.</sub>',
    '',
  ].join('\n');
}

// About 12 stills of the recording, as small JPEGs, for the automatic diagnosis: it reads images, not video.
async function videoFrames(blob, count = 12) {
  const video = Object.assign(document.createElement('video'), { muted: true, src: URL.createObjectURL(blob) });
  const seek = (t) => new Promise((resolve) => { video.onseeked = resolve; video.currentTime = t; });
  try {
    await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = reject; });
    // MediaRecorder's WebM has no duration until the player has seeked to the end
    if (!Number.isFinite(video.duration)) await seek(1e9);
    const scale = Math.min(1, 960 / video.videoWidth);
    const canvas = Object.assign(document.createElement('canvas'),
      { width: Math.round(video.videoWidth * scale), height: Math.round(video.videoHeight * scale) });
    const frames = [];
    for (let i = 0; i < count; i++) {
      await seek((video.duration * (i + 0.5)) / count);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL('image/jpeg', 0.7).split(',')[1]);
    }
    return frames;
  } finally {
    URL.revokeObjectURL(video.src);
  }
}

function updateDupLink() {
  const words = $('title').value.replace(/[^\w\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 5).join(' ');
  $('dupLink').href = `https://github.com/${$('repo').value}/issues?q=${encodeURIComponent(`is:issue ${words}`)}`;
}

// ---- GitHub fields: repo dropdown, then the chosen repo's assignees ----
let token = '';
let fieldsLoad = 0;
let repos = [UI_REPO, SERVICE_REPO]; // the main two are usable straight away; the full list takes a few pages
let currentRepo = '';

async function loadRepos() {
  try {
    const listed = await listRepos(token);
    repos = [...new Set([UI_REPO, SERVICE_REPO, ...listed])];
  } catch (err) {
    $('githubConn').textContent = `Repo list unavailable (${err.message}). You can still type owner/name.`;
  }
  repoCombo.refresh();
}

// Assignees and labels are not carried over between reports: pre-filled people from an old report were surprising.
// Only reopening the same report brings back its own picks. Clears what older versions remembered.
chrome.storage.local.remove('lastChoice');
const ownPicks = (repo, field) => (report?.repo === repo ? report[field] || [] : []);

// Setting the field fires 'change', which reloads assignees and labels and re-checks the field.
function setRepo(value) {
  $('repo').value = value;
  $('repo').dispatchEvent(new Event('change'));
  updateDupLink();
}

const repoCombo = createCombo({
  input: $('repo'),
  listbox: $('repoOptions'),
  toggle: $('repoToggle'),
  container: $('repoCombo'),
  items: () => repos,
  pinned: 2,
  isCurrent: (value) => value === currentRepo,
  onPick: setRepo,
  onEnter: setRepo,
  emptyText: (q) => (q ? `No listed repo matches "${q}". Press Enter to use it as typed (owner/name).` : 'Loading repos…'),
});

const MAX_ASSIGNEES = 10; // GitHub's limit per issue
const assignees = createChipPicker({
  prefix: 'assignee',
  max: MAX_ASSIGNEES,
  maxText: (n) => `GitHub allows at most ${n} assignees.`,
  placeholder: { none: 'Search people…', some: 'Add another person…', full: `Limit of ${MAX_ASSIGNEES} reached` },
  emptyText: (q, all) => (q ? `Nobody matches "${q}".` : all.length ? 'Everyone is already picked.' : 'Nobody can be assigned in this repo.'),
  noneText: 'Nobody can be assigned in this repo.',
  splitText: (text) => text.split(/[\s,]+/).map((s) => s.replace(/^@/, '')).filter(Boolean),
});

const labels = createChipPicker({
  prefix: 'label',
  max: 20,
  maxText: (n) => `At most ${n} labels.`,
  placeholder: { none: 'Search labels…', some: 'Add another label…', full: 'Limit reached' },
  emptyText: (q, all) => (q ? `No label matches "${q}".` : all.length ? 'Every label is already picked.' : 'This repo has no labels.'),
  noneText: 'This repo has no labels.',
  // label names can contain spaces, so only commas separate them
  splitText: (text) => text.split(',').map((s) => s.trim()).filter(Boolean),
});

async function loadRepoFields() {
  const repo = $('repo').value.trim();
  // Enter, then blur, both fire 'change': reloading the same repo shifts the layout under the next click
  if (!REPO_RE.test(repo) || repo === currentRepo) return;
  currentRepo = repo;
  const load = ++fieldsLoad; // a slower lookup for a previous repo must not overwrite this one
  assignees.loading('Loading people…');
  labels.loading('Loading labels…');
  await Promise.all([
    listAssignees(repo, token).then(
      (logins) => { if (load === fieldsLoad) assignees.setOptions(logins, ownPicks(repo, 'assignees')); },
      (err) => { if (load === fieldsLoad) assignees.useText(`Couldn't list people (${err.message}). Type GitHub usernames instead.`, ownPicks(repo, 'assignees')); }),
    listLabels(repo, token).then(
      (names) => { if (load === fieldsLoad) labels.setOptions(names, ownPicks(repo, 'labels')); },
      (err) => { if (load === fieldsLoad) labels.useText(`Couldn't list labels (${err.message}). Type label names instead.`, ownPicks(repo, 'labels')); }),
  ]);
}

async function initGithubFields() {
  token = await getToken();
  const conn = $('githubConn');
  conn.replaceChildren(token ? 'Connected to GitHub. ' : 'Not connected to GitHub: only public egovernments repos are listed. ');
  const link = Object.assign(document.createElement('a'), { href: '#', textContent: token ? 'Settings' : 'Connect GitHub' });
  link.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  conn.append(link);

  $('repo').addEventListener('change', loadRepoFields);
  await Promise.all([loadRepos(), loadRepoFields()]);
}

// ---- Field validation: each message sits under its own field and clears once that field is fixed ----
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const CHECKS = [
  ['repo', () => REPO_RE.test($('repo').value.trim()) || 'Pick a repository in the form owner/name, e.g. egovernments/DIGIT-Frontend.'],
  ['assigneeText', () => {
    if ($('assigneeText').hidden) return true;
    const bad = assignees.values().filter((l) => !LOGIN_RE.test(l));
    return !bad.length || `Not a GitHub username: ${bad.join(', ')}.`;
  }],
  ['title', () => !!$('title').value.trim() || 'Add a title.'],
  ['apiList', () => {
    const n = buildBody().length + $('title').value.length + 4;
    return n <= BODY_LIMIT || `The issue text is ${Math.ceil(n / 1000)} KB, over GitHub's 65 KB limit. Untick some API calls.`;
  }],
  ['pii', () => $('pii').checked || 'Tick this box after checking the video, screenshot and text for personal data.'],
];

function setFieldError(id, message) {
  const field = $(id);
  const errorId = `${id}Error`;
  let el = $(errorId);
  if (!message) {
    el?.remove();
    field.removeAttribute('aria-invalid');
    return;
  }
  if (!el) {
    el = Object.assign(document.createElement('p'), { id: errorId, className: 'field-error' });
    (field.closest('label, .combo') || field).after(el);
  }
  el.textContent = message;
  field.setAttribute('aria-invalid', 'true');
  field.setAttribute('aria-describedby', errorId);
}

// Shows every problem at once and returns the first field that needs fixing.
function validate() {
  let first = null;
  for (const [id, check] of CHECKS) {
    const result = check();
    setFieldError(id, result === true ? '' : result);
    if (result !== true) first ??= id;
  }
  return first;
}

// Re-check a field as soon as it changes, so its message goes away when fixed.
for (const [id, check] of CHECKS) {
  for (const type of ['input', 'change']) {
    $(id).addEventListener(type, () => { if ($(`${id}Error`)) { const r = check(); setFieldError(id, r === true ? '' : r); } });
  }
}

function status(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

const showFailure = (err) => status(`Something went wrong: ${err?.message || err}. Use "Copy as Markdown" instead.`, true);
window.addEventListener('error', (e) => showFailure(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showFailure(e.reason));

let report = await db.get(id);
let calls = []; // network events, oldest first
const picks = new Set(); // indexes into calls
let origin = '';
const pickedCalls = () => calls.filter((_, i) => picks.has(i));

function updateApiCount() {
  $('apiCount').textContent = calls.length ? `${calls.length} recorded · ${picks.size} ticked` : '';
  if (!report) return;
  const n = buildBody().length;
  $('apiSize').textContent = `Issue text: ${Math.ceil(n / 1000)} KB of GitHub's 65 KB limit.`;
  $('apiSize').classList.toggle('over', n > BODY_LIMIT);
}

function filterApiList() {
  const q = $('apiFilter').value.trim().toLowerCase();
  const failedOnly = $('apiFailedOnly').checked;
  for (const li of $('apiList').children) {
    const c = calls[li.dataset.i];
    li.hidden = (failedOnly && !isFailed(c)) || (q && !callTitle(c).toLowerCase().includes(q) && !(c.error || '').toLowerCase().includes(q));
  }
}

function renderApiList() {
  $('apiEmpty').hidden = calls.length > 0;
  $('apiList').replaceChildren(...calls.map((c, i) => {
    const li = document.createElement('li');
    li.dataset.i = i;
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: picks.has(i) });
    box.setAttribute('aria-label', `Include ${c.method} ${c.url}`);
    box.addEventListener('change', () => { if (box.checked) picks.add(i); else picks.delete(i); updateApiCount(); });
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const st = Object.assign(document.createElement('span'), { className: `api-status${isFailed(c) ? ' bad' : ''}`, textContent: c.status || 'failed' });
    summary.append(`${c.method} ${c.url} → `, st, c.ms != null ? ` · ${c.ms} ms` : '');
    if (c.error) summary.append(' ', Object.assign(document.createElement('span'), { className: 'api-err', textContent: c.error }));
    // curl and response are built on first open: a page can record a lot of calls
    details.addEventListener('toggle', () => {
      if (!details.open || details.childElementCount > 1) return;
      const pre = (text) => Object.assign(document.createElement('pre'), { textContent: text });
      const h = (text) => Object.assign(document.createElement('h4'), { textContent: text });
      const json = parseJson(c.response || '');
      details.append(h('curl'), pre(curlOf(c, origin)), h('Response'),
        pre(json !== undefined ? JSON.stringify(json, null, 2) : c.response || '(empty)'));
    });
    details.append(summary);
    const row = document.createElement('div');
    row.className = 'api-row';
    row.append(box, details);
    li.append(row);
    return li;
  }));
  filterApiList();
  updateApiCount();
}

if (!report) {
  $('missing').hidden = false;
  $('form').hidden = true;
} else {
  const events = (report.events || []).map((e) => ({
    ...e,
    url: e.url && clean(e.url),
    text: e.text && clean(e.text),
    error: e.error && clean(e.error),
    body: e.body && clean(e.body),
    response: e.response && clean(e.response),
  }));
  const tabUrl = clean(report.tabUrl);

  if (report.video?.size) {
    $('videoBox').hidden = false;
    $('video').src = URL.createObjectURL(report.video);
    const mb = report.video.size / 1e6;
    $('videoSize').textContent = `${mb.toFixed(1)} MB${mb > 10 ? ' · over GitHub’s 10 MB limit on free plans' : ''}`;
  } else {
    $('includeVideo').checked = false;
  }
  if (report.screenshot) {
    $('shotBox').hidden = false;
    $('shot').src = report.screenshot;
  } else {
    $('includeShot').checked = false;
  }

  const [repo, why, type] = suggestRepo(events);
  $('repo').value = report.repo || repo;
  $('repoWhy').textContent = why;
  fillSelect($('type'), TYPES, report.type || type);
  fillSelect($('severity'), SEVERITIES, report.severity || 'Medium');
  fillSelect($('priority'), PRIORITIES, report.priority || 'P2');
  $('env').value = environmentLine(report.tabUrl, events, report.pageInfo);
  $('steps').value = draftSteps(tabUrl, events);
  $('evidence').value = evidenceText(events);
  try { origin = new URL(report.tabUrl).origin; } catch { /* no url */ }
  calls = events.filter((e) => e.kind === 'network');
  const saved = Array.isArray(report.apiPicks) ? report.apiPicks : null;
  calls.forEach((c, i) => { if (saved ? saved.includes(i) : isFailed(c)) picks.add(i); });
  renderApiList();
  $('apiFilter').addEventListener('input', filterApiList);
  $('apiFailedOnly').addEventListener('change', filterApiList);
  $('apiPickFailed').addEventListener('click', () => {
    calls.forEach((c, i) => { if (isFailed(c)) picks.add(i); });
    renderApiList();
  });
  $('apiClear').addEventListener('click', () => { picks.clear(); renderApiList(); });
  for (const el of ['evidence', 'steps', 'summary', 'notes']) $(el).addEventListener('change', updateApiCount);
  $('component').value = componentOf(report.tabUrl);
  if (report.title) $('title').value = report.title;

  if (report.mdms?.length) {
    $('mdmsNote').hidden = false;
    $('mdmsNote').textContent = `${report.mdms.length} MDMS config records the page loaded were kept for the automatic diagnosis. `
      + 'They stay on this computer and are not added to the issue.';
  }
  const masked = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
  $('redactions').textContent = masked ? `Redacted automatically: ${masked}.` : 'Nothing needed redacting.';
  if (report.captureRestartedAt) {
    $('captureNote').hidden = false;
    $('captureNote').textContent = `API and console capture wasn't running in this tab (it was open when the extension was `
      + `installed or updated) and was restarted at ${new Date(report.captureRestartedAt).toLocaleTimeString()}. `
      + 'Calls before that are missing: reproduce the bug again if they matter.';
  }

  updateDupLink();
  for (const el of ['title', 'repo']) $(el).addEventListener('input', updateDupLink);
  initGithubFields();

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const invalid = validate();
    if (invalid) {
      status('');
      $(invalid).focus();
      $(invalid).scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    try {
      const repo = $('repo').value.trim();
      const fields = {
        title: $('title').value.trim(),
        repo,
        assignees: assignees.values(),
        labels: labels.values(),
        type: $('type').value,
        severity: $('severity').value,
        priority: $('priority').value,
      };
      await db.update(id, {
        ...fields,
        body: buildBody(),
        includeVideo: $('includeVideo').checked,
        includeScreenshot: $('includeShot').checked,
        apiPicks: [...picks],
      });
      report = await db.get(id);
      // The tracker row; github-attach.js adds the issue URL once the issue is created.
      await saveBug(id, { ...fields, env: envName(report.tabUrl), reportedAt: report.createdAt }, 'Opened on GitHub for review');
      // GitHub's new-issue URL pre-selects assignees and labels (applied only if you have triage/write access)
      const params = new URLSearchParams();
      if (fields.assignees.length) params.set('assignees', fields.assignees.join(','));
      if (fields.labels.length) params.set('labels', fields.labels.join(','));
      const query = params.toString();
      // tabs.create, not window.open: a popup blocker can swallow window.open after the await above
      await chrome.tabs.create({ url: `https://github.com/${repo}/issues/new${query ? `?${query}` : ''}#digitbug2=${id}` });
      status('GitHub opened in a new tab. Check the filled form there, wait for the uploads to finish, then click Create.');
      // ready before Create is clicked; a failure only means the diagnosis works from the screenshot and steps
      if (report.video?.size && !report.frames) videoFrames(report.video).then((frames) => db.update(id, { frames }), () => {});
    } catch (err) {
      showFailure(err);
    }
  });

  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(`# ${$('title').value.trim()}\n\n${buildBody()}`);
    status('Copied. Attach the video and screenshot yourself if you paste it somewhere else.');
  });

  $('downloadVideo').disabled = !report.video?.size;
  $('downloadVideo').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(report.video);
    a.download = `digit-bug-${new Date(report.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, '')}.webm`;
    a.click();
  });

  $('discard').addEventListener('click', async () => {
    if (!confirm('Delete this recording and draft?')) return;
    await db.remove(id);
    window.close();
  });
}
