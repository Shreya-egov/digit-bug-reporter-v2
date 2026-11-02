const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const MODES = {
  both: { button: '● Start recording', hint: 'Records this tab (no audio, max 2 min) and takes a screenshot when you stop.' },
  video: { button: '● Start recording', hint: 'Records this tab (no audio, max 2 min). No screenshot.' },
  screenshot: { button: '📷 Take screenshot', hint: 'Takes a screenshot of this tab now. No video.' },
};
const EXTRA = ' Failing API calls, console errors and your clicks are captured too.';

function showError(text) { $('error').textContent = text || ''; }

const currentMode = () => document.querySelector('input[name=mode]:checked')?.value || 'both';

function showMode() {
  const m = MODES[currentMode()];
  $('start').textContent = m.button;
  $('hint').textContent = m.hint + EXTRA;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render() {
  const { mode = 'both' } = await chrome.storage.local.get('mode');
  document.querySelector(`input[name=mode][value=${MODES[mode] ? mode : 'both'}]`).checked = true;
  showMode();

  const { rec } = await send({ type: 'status' });
  $('idle').hidden = !!rec;
  $('recording').hidden = !rec;
  if (rec) {
    const tick = () => {
      const s = Math.floor((Date.now() - rec.startedAt) / 1000);
      $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    setInterval(tick, 1000);
  }
}

for (const radio of document.querySelectorAll('input[name=mode]')) {
  radio.addEventListener('change', () => {
    showMode();
    chrome.storage.local.set({ mode: currentMode() });
  });
}

$('start').addEventListener('click', async () => {
  showError('');
  const mode = currentMode();
  try {
    const tab = await activeTab();
    if (mode === 'screenshot') {
      const res = await send({ type: 'snapshot', tabId: tab.id });
      if (!res.ok) throw new Error(res.error);
    } else {
      // must be requested from the popup: it is the user's gesture that allows capturing this tab
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const res = await send({ type: 'start', tabId: tab.id, streamId, withScreenshot: mode === 'both' });
      if (!res.ok) throw new Error(res.error);
    }
    window.close();
  } catch (e) {
    showError(`Can't capture this tab: ${e.message}`);
  }
});

$('stop').addEventListener('click', async () => {
  $('stop').disabled = true;
  const res = await send({ type: 'stop' });
  if (!res.ok) { showError(res.error); $('stop').disabled = false; return; }
  window.close();
});

$('tracker').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('tracker.html') });
  window.close();
});

render();
