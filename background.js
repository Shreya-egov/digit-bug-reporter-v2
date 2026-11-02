// Service worker: keeps a rolling log of page events per tab, drives the recorder, assembles the report, and keeps
// the bug tracker in step with GitHub.
import * as db from './db.js';
import { parseIssueUrl, saveBug, syncAll, syncBug } from './bugs.js';
import { getToken } from './github-api.js';

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
chrome.runtime.onStartup.addListener(() => chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_MINUTES }));

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) syncAll().catch((e) => console.warn('bug sync', e));
});

// Read in the page when capture finishes: events from page load may be older than the lookback window.
// The UI build is the hashed name of the app bundle, which changes with every deploy.
function readPage() {
  let tenant = null;
  try { tenant = localStorage.getItem('Employee.tenant-id'); } catch { /* storage blocked */ }
  const bundles = [...document.scripts].map((s) => s.src).filter((src) => src.startsWith(location.origin))
    .map((src) => new URL(src).pathname.split('/').pop()).filter((name) => /[.-][0-9a-f]{8,}(\.(bundle|chunk))?\.js$/.test(name));
  // DIGIT UIs ship the app as digit-ui.<hash>.bundle.js; main.<hash>.js covers create-react-app builds
  const build = bundles.find((n) => /^(digit-ui|main)[.-]/.test(n)) || null;
  return { tenant, build };
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
  const [screenshot, events, info] = await Promise.all([screenshotPromise, eventsSince(tabId, since - LOOKBACK_MS), pageInfo(tabId)]);
  let tabUrl;
  try { tabUrl = (await chrome.tabs.get(tabId)).url; } catch { /* tab closed */ }
  await db.update(id, { screenshot, events, pageInfo: info, startedAt: since, endedAt: Date.now(), ...(tabUrl && { tabUrl }) });
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
  await syncBug(bug, await getToken()).catch(() => {}); // the next periodic sync retries
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
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec?.tabId === tabId) await stop();
  serial(() => chrome.storage.session.remove(`ev:${tabId}`));
});
