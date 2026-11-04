// Service worker: keeps a rolling log of page events per tab, drives the recorder, assembles the report, and keeps
// the bug tracker in step with GitHub.
import * as db from './db.js';
import { CONFIDENT_VERDICTS, parseIssueUrl, saveBug, syncAll, syncBug, verdictKind } from './bugs.js';
import { getToken, request } from './github-api.js';
import { redact } from './redact.js';

const EVENTS_PER_TAB = 300;
const LOOKBACK_MS = 60_000; // include events from just before Start (e.g. errors on page load)

// ---- rolling event log (storage.session survives the worker being suspended) ----
let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn).catch((e) => console.warn('event log', e)));

function addEvent(tabId, event) {
  return serial(async () => {
    const key = `ev:${tabId}`;
    const { [key]: list = [] } = await chrome.storage.session.get(key);
    list.push(event);
    if (list.length > EVENTS_PER_TAB) list.splice(0, list.length - EVENTS_PER_TAB);
    await chrome.storage.session.set({ [key]: list });
  });
}

async function eventsSince(tabId, since) {
  await chain;
  const key = `ev:${tabId}`;
  const { [key]: list = [] } = await chrome.storage.session.get(key);
  return list.filter((e) => e.ts >= since);
}

// ---- recording state ----
const getRec = async () => (await chrome.storage.session.get('rec')).rec || null;
const setRec = (rec) => (rec ? chrome.storage.session.set({ rec }) : chrome.storage.session.remove('rec'));

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Record the tab the user is reporting a bug on',
  });
}

async function screenshotOf(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return null; // captureVisibleTab would grab whatever tab is in front
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch {
    return null;
  }
}

// A DIGIT tab that was open when the extension was installed, reloaded or updated has no working capture: the
// old relay.js copy is cut off from the extension. Put fresh scripts in; page-hook.js skips itself if the page
// already has one. Returns true when capture had to be (re)started, so events before now are missing.
async function ensureCapture(tabId) {
  const alive = await chrome.tabs.sendMessage(tabId, { type: 'relay-ping' }).catch(() => false);
  if (alive) return false;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['page-hook.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['relay.js'] });
    return true;
  } catch {
    return false; // not a DIGIT tab, or a page scripts can't run in
  }
}

const SYNC_ALARM = 'sync-bugs';
const SYNC_MINUTES = 30;

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_MINUTES });
  for (const tab of await chrome.tabs.query({ url: 'https://*.digit.org/*' })) ensureCapture(tab.id);
});

// alarms are not guaranteed to survive a browser restart; creating it again replaces it
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_MINUTES });
  checkDiagnoses().catch(() => {}); // pick up runs that finished while Chrome was closed
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncAll().catch((e) => console.warn('bug sync', e));
  if (alarm.name === DIAG_ALARM) checkDiagnoses().catch((e) => console.warn('diagnosis status', e));
});

// ---- automatic diagnosis through the native host (automation/native-host) ----
// The host starts automation/auto-triage.sh, a read-only Claude Code diagnosis, and reports its verdict.
const TRIAGE_HOST = 'org.digit.bug_triage';
const DIAG_ALARM = 'diagnosis-status';
const UI_REPO = 'egovernments/DIGIT-Frontend';

async function triageHost(msg) {
  try {
    const res = await chrome.runtime.sendNativeMessage(TRIAGE_HOST, msg);
    return res?.ok ? res : { ok: false, error: res?.error || 'no answer from the diagnosis helper' };
  } catch (e) {
    return { ok: false, missing: /not found|forbidden|access/i.test(e.message), error: e.message };
  }
}

const isFrontendBug = (b) => b.repo === UI_REPO || b.type === 'UI';
const autoDiagnoseOn = async () => (await chrome.storage.local.get('autoDiagnose')).autoDiagnose !== false;
const autoCommentOn = async () => (await chrome.storage.local.get('autoComment')).autoComment !== false;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// Post the diagnosis's drafted fix on the issue for its assignee: confident verdicts only, once per diagnosis.
// Posted here, with the user's token, and not by the diagnosis run, which never holds a token.
async function postDiagnosisComment(bug, anyVerdict = false) {
  const d = bug.diagnosis;
  if (d?.state !== 'done' || d.commentUrl) return;
  if (!anyVerdict && !CONFIDENT_VERDICTS.includes(verdictKind(d.verdict))) {
    await saveBug(bug.id, {}, `Diagnosis not posted: "${verdictKind(d.verdict)}" isn't a confident verdict. Check the report.`);
    return;
  }
  const token = await getToken();
  if (!token) {
    await saveBug(bug.id, {}, 'Diagnosis not posted: connect a GitHub token with Issues write access in Settings.');
    return;
  }
  const res = await triageHost({ type: 'report', url: bug.issueUrl });
  if (!res.ok || !res.comment?.trim()) {
    await saveBug(bug.id, {}, `Diagnosis not posted: no draft comment (${res.error || 'comment.md is empty'}).`);
    return;
  }
  const mentions = (bug.assignees || []).filter((l) => LOGIN_RE.test(l)).map((l) => `@${l}`).join(' ');
  const body = [
    `${mentions ? `${mentions}: ` : ''}automated diagnosis of this issue. It is read-only: nothing was changed.`,
    '',
    `**Verdict:** ${redact(d.verdict).text}`,
    '',
    redact(res.comment.trim()).text.slice(0, 60_000),
    '',
    '<sub>Posted by DIGIT Bug Reporter v2 from a read-only Claude Code diagnosis. Please check it before applying.</sub>',
  ].join('\n');
  const issue = parseIssueUrl(bug.issueUrl);
  try {
    const { data } = await request(`/repos/${issue.repo}/issues/${issue.number}/comments`, token,
      { method: 'POST', body: JSON.stringify({ body }) });
    await saveBug(bug.id, { diagnosis: { ...d, commentUrl: data.html_url } }, `Diagnosis posted for the assignee: ${data.html_url}`);
  } catch (err) {
    const hint = /403|404|rejected/.test(err.message) ? ' The token needs Issues write access (Settings).' : '';
    await saveBug(bug.id, {}, `Diagnosis not posted: ${err.message}.${hint} Use Copy draft comment instead.`);
  }
}

// Record a status from the host on the bug; logs only real changes.
async function applyDiagnosis(bug, s, note) {
  const prev = bug.diagnosis || {};
  const next = {
    state: s.state,
    verdict: s.verdict ?? (s.state === 'running' ? '' : prev.verdict || ''),
    at: s.at || Date.now(),
    dir: s.dir || prev.dir || '',
    startedAt: s.state === 'running' ? (prev.state === 'running' ? prev.startedAt : Date.now()) : prev.startedAt,
  };
  if (!note && prev.state === next.state && prev.verdict === next.verdict) return;
  const text = note || (next.state === 'done' ? `Diagnosis: ${next.verdict}`
    : next.state === 'failed' ? 'Diagnosis failed: see run.log in the report folder' : null);
  const row = await saveBug(bug.id, { diagnosis: next }, text);
  if (next.state === 'running') chrome.alarms.create(DIAG_ALARM, { periodInMinutes: 0.5 });
  if (next.state === 'done' && prev.state !== 'done' && await autoCommentOn()) await postDiagnosisComment(row);
}

async function startDiagnosis(id, force = false) {
  const bug = await db.bugs.get(id);
  if (!bug?.issueUrl) throw new Error('the bug has no GitHub issue yet');
  const report = await db.get(id); // gone if the report was pruned; frames are optional
  const res = await triageHost({ type: 'diagnose', url: bug.issueUrl, force, frames: report?.frames || [], mdms: report?.mdms || [] });
  if (!res.ok) {
    await saveBug(id, { diagnosis: { ...bug.diagnosis, state: res.missing ? 'no-helper' : 'error', error: res.error, at: Date.now() } },
      `Diagnosis not started: ${res.error}`);
    return res;
  }
  await applyDiagnosis(bug, res, res.state === 'running' ? (force ? 'Diagnosis started again' : 'Diagnosis started') : undefined);
  return res;
}

async function checkDiagnoses() {
  const running = (await db.bugs.all()).filter((b) => b.diagnosis?.state === 'running' && b.issueUrl);
  if (!running.length) { await chrome.alarms.clear(DIAG_ALARM); return; }
  const res = await triageHost({ type: 'status', urls: running.map((b) => b.issueUrl) });
  if (!res.ok) return;
  for (const b of running) {
    const s = res.results[b.issueUrl];
    if (s && s.state !== 'running') await applyDiagnosis(b, s.state === 'none' ? { state: 'failed' } : s);
  }
}

// Read in the page when capture finishes: events from page load may be older than the lookback window.
// The UI build is the hashed name of the app bundle, which changes with every deploy.
function readPage() {
  let tenant = null;
  try { tenant = localStorage.getItem('Employee.tenant-id'); } catch { /* storage blocked */ }
  const bundles = [...document.scripts].map((s) => s.src).filter((src) => src.startsWith(location.origin))
    .map((src) => new URL(src).pathname.split('/').pop()).filter((name) => /[.-][0-9a-f]{8,}(\.(bundle|chunk))?\.js$/.test(name));
  // DIGIT UIs ship the app as digit-ui.<hash>.bundle.js; main.<hash>.js covers create-react-app builds
  const build = bundles.find((n) => /^(digit-ui|main)[.-]/.test(n)) || null;
  return { tenant, build, mdms: window.__digitBugV2Mdms?.() || [] };
}

async function pageInfo(tabId) {
  const { os, arch } = await chrome.runtime.getPlatformInfo();
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: readPage });
    return { os, arch, ...result };
  } catch {
    return { os, arch }; // tab closed or navigated away
  }
}

async function newReport(tab) {
  const report = { id: crypto.randomUUID(), createdAt: Date.now(), tabId: tab.id, tabUrl: tab.url || '', tabTitle: tab.title || '' };
  await db.put(report);
  await db.prune();
  return report;
}

async function finishReport(id, tabId, since, screenshotPromise = screenshotOf(tabId)) {
  const [screenshot, events, { mdms = [], ...info }] = await Promise.all([screenshotPromise, eventsSince(tabId, since - LOOKBACK_MS), pageInfo(tabId)]);
  let tabUrl;
  try { tabUrl = (await chrome.tabs.get(tabId)).url; } catch { /* tab closed */ }
  await db.update(id, { screenshot, events, pageInfo: info, mdms, startedAt: since, endedAt: Date.now(), ...(tabUrl && { tabUrl }) });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`preview.html?id=${id}`) });
}

async function start(tabId, streamId, withScreenshot = true) {
  if (await getRec()) throw new Error('Already recording');
  const tab = await chrome.tabs.get(tabId);
  const report = await newReport(tab);
  if (await ensureCapture(tabId)) await db.update(report.id, { captureRestartedAt: Date.now() });
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId });
  if (!res?.ok) {
    await db.remove(report.id);
    throw new Error(res?.error || 'Could not start recording');
  }
  await setRec({ tabId, id: report.id, startedAt: Date.now(), withScreenshot });
  await chrome.action.setBadgeBackgroundColor({ color: '#d4351c' });
  await chrome.action.setBadgeText({ text: 'REC' });
}

let stopping = null;
function stop() {
  // auto-stop, tab close and the Stop button can race; run once
  stopping ??= (async () => {
    const rec = await getRec();
    if (!rec) return;
    await setRec(null);
    await chrome.action.setBadgeText({ text: '' });
    // screenshot before the recorder stops, while the bug is still on screen
    const screenshotPromise = rec.withScreenshot === false ? Promise.resolve(null) : screenshotOf(rec.tabId);
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop', id: rec.id });
    await chrome.offscreen.closeDocument().catch(() => {});
    if (!res?.ok) console.warn('recorder stop failed', res?.error);
    await finishReport(rec.id, rec.tabId, rec.startedAt, screenshotPromise);
  })().finally(() => { stopping = null; });
  return stopping;
}

async function snapshot(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const report = await newReport(tab);
  if (await ensureCapture(tabId)) await db.update(report.id, { captureRestartedAt: Date.now() });
  await finishReport(report.id, tabId, Date.now() - 2 * LOOKBACK_MS);
}

// GitHub content script asks for the approved draft and its media.
async function githubPayload(id) {
  const r = await db.get(id);
  if (!r?.title) return null;
  const files = [];
  if (r.screenshot && r.includeScreenshot !== false) files.push({ name: 'screenshot.png', type: 'image/png', base64: r.screenshot.split(',')[1] });
  if (r.video?.size && r.includeVideo !== false) {
    files.push({ name: 'recording.webm', type: 'video/webm', base64: await blobToBase64(r.video) });
  }
  return { title: r.title, body: r.body, files, assignees: r.assignees || [] };
}

// github-attach.js saw the issue page that GitHub opens after Create.
async function issueCreated(id, url) {
  if (!parseIssueUrl(url)) throw new Error(`not an issue URL: ${url}`);
  const bug = await saveBug(id, { issueUrl: url, issueState: 'open' }, `Issue created: ${url}`);
  const synced = await syncBug(bug, await getToken()).catch(() => bug); // the next periodic sync retries
  if (isFrontendBug(synced) && await autoDiagnoseOn()) await startDiagnosis(id).catch((e) => console.warn('diagnosis', e));
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return;
  const reply = (p) => {
    p.then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  };
  switch (msg.type) {
    case 'event':
      if (sender.tab?.id != null) addEvent(sender.tab.id, msg.event);
      return;
    case 'status':
      return reply(getRec().then((rec) => ({ rec })));
    case 'start':
      return reply(start(msg.tabId, msg.streamId, msg.withScreenshot));
    case 'stop':
    case 'auto-stop':
      return reply(stop());
    case 'snapshot':
      return reply(snapshot(msg.tabId));
    case 'github-payload':
      return reply(githubPayload(msg.id).then((payload) => ({ payload })));
    case 'issue-created':
      return reply(issueCreated(msg.id, msg.url));
    case 'sync-bugs':
      return reply(syncAll());
    case 'diagnose':
      return reply(startDiagnosis(msg.id, msg.force));
    case 'diagnosis-report':
      return reply(db.bugs.get(msg.id).then((b) => (b?.issueUrl ? triageHost({ type: 'report', url: b.issueUrl })
        : { ok: false, error: 'no GitHub issue' })).then((r) => { if (!r.ok) throw new Error(r.error); return r; }));
    case 'post-diagnosis':
      return reply(db.bugs.get(msg.id).then((b) => postDiagnosisComment(b, msg.anyVerdict === true)));
    case 'triage-ping':
      return reply(triageHost({ type: 'ping' }));
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec?.tabId === tabId) await stop();
  serial(() => chrome.storage.session.remove(`ev:${tabId}`));
});
