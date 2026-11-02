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
  return [
    `${u.host}${env ? ` (${env})` : ''}`,
    tenant && `tenant ${tenant}`,
    campaign && `campaign ${campaign}${flow ? ` / flow ${flow}` : ''}`,
    chrome && `Chrome ${chrome}${os ? ` on ${os}` : ''}`,
    `UI build: ${info.build || 'not captured'}`,
  ].filter(Boolean).join(', ');
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
  const calls = dedupe(events.filter((e) => e.kind === 'network')
    .map((e) => `${e.method} ${e.url} → ${e.status || 'failed'}${e.error ? `  ${e.error}` : ''}`));
  const errors = dedupe(events.filter((e) => e.kind === 'console').map((e) => e.text));
  const parts = [];
  if (calls.length) parts.push('Failing API calls:\n' + calls.join('\n'));
  if (errors.length) parts.push('Console errors:\n' + errors.slice(0, 20).join('\n'));
  return parts.join('\n\n') || 'No failing API calls or console errors were captured.';
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
    section('Evidence', `${media ? `The ${media} ${media.includes(' and ') ? 'are' : 'is'} attached below.\n\n` : ''}\`\`\`text\n${v('evidence')}\n\`\`\``),
    section('Notes', v('notes')),
    `**Severity:** ${v('severity')}   **Priority:** ${v('priority')}   **Type:** ${v('type')}   **Component:** ${v('component') || 'not set'}`,
    '',
    '<sub>Captured with DIGIT Bug Reporter. Evidence was redacted automatically and reviewed by the reporter.</sub>',
    '',
  ].join('\n');
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

if (!report) {
  $('missing').hidden = false;
  $('form').hidden = true;
} else {
  const events = (report.events || []).map((e) => ({
    ...e,
    url: e.url && clean(e.url),
    text: e.text && clean(e.text),
    error: e.error && clean(e.error),
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
  $('component').value = componentOf(report.tabUrl);
  if (report.title) $('title').value = report.title;

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
      await chrome.tabs.create({ url: `https://github.com/${repo}/issues/new${query ? `?${query}` : ''}#digitbug=${id}` });
      status('GitHub opened in a new tab. Check the filled form there, wait for the uploads to finish, then click Create.');
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
