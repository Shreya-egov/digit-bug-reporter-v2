// Records the tab stream handed over by the service worker. Lives in an offscreen document because
// service workers can't use MediaRecorder.
import * as db from './db.js';

const MAX_MS = 120_000; // ~9 MB at the bitrate below; GitHub's video limit is 10 MB on free plans
const SNAPSHOT_EVERY_MS = 10_000; // Video + screenshot mode: a still every 10 s while recording
const MAX_SNAPSHOTS = 40; // 12 timed in 2 min, the rest taken by hand

let recorder = null;
let stream = null;
let chunks = [];
let timer = null;
let snapTimer = null;
let player = null; // plays the tab stream so frames can be drawn to a canvas
let startedAt = 0;
let snapshots = [];

// A still of the tab from the recorded stream: works even when the tab isn't the one in front.
function grab(manual) {
  if (!player?.videoWidth || snapshots.length >= MAX_SNAPSHOTS) return null;
  const canvas = Object.assign(document.createElement('canvas'), { width: player.videoWidth, height: player.videoHeight });
  canvas.getContext('2d').drawImage(player, 0, 0);
  const shot = { at: Date.now() - startedAt, manual, dataUrl: canvas.toDataURL('image/jpeg', 0.9) };
  snapshots.push(shot);
  return shot;
}

async function start(streamId, timedSnapshots) {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1440,
        maxHeight: 900,
        maxFrameRate: 12,
      },
    },
  });
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((t) => MediaRecorder.isTypeSupported(t));
  recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 600_000 });
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start(1000);
  timer = setTimeout(() => chrome.runtime.sendMessage({ type: 'auto-stop' }), MAX_MS);
  startedAt = Date.now();
  snapshots = [];
  player = Object.assign(document.createElement('video'), { muted: true, srcObject: stream });
  await player.play().catch(() => {});
  if (timedSnapshots) snapTimer = setInterval(() => grab(false), SNAPSHOT_EVERY_MS);
}

function snap() {
  const shot = grab(true);
  if (!shot) throw new Error(snapshots.length >= MAX_SNAPSHOTS ? `limit of ${MAX_SNAPSHOTS} snapshots reached` : 'not recording');
  return { at: shot.at, count: snapshots.length };
}

async function stop(id) {
  clearTimeout(timer);
  clearInterval(snapTimer);
  if (!recorder) return { size: 0 };
  await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
  stream.getTracks().forEach((t) => t.stop());
  const video = new Blob(chunks, { type: 'video/webm' });
  if (player) player.srcObject = null;
  const taken = snapshots;
  recorder = null; stream = null; chunks = []; player = null; snapshots = [];
  await db.update(id, { video, snapshots: taken });
  return { size: video.size, snapshots: taken.length };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  const run = msg.type === 'start' ? start(msg.streamId, msg.timedSnapshots)
    : msg.type === 'snap' ? Promise.resolve().then(snap) : stop(msg.id);
  run.then((r) => sendResponse({ ok: true, ...r }), (err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
