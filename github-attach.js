// On github.com/<repo>/issues/new#digitbug2=<id>: fill in the reviewed title and body and upload the media.
// Never clicks Create; the user does that after checking the form. When the user does, GitHub opens the new
// issue in the same tab, and its URL goes to the bug tracker.
(() => {
  const KEY = 'digitbug2-pending';
  const CREATED_KEY = 'digitbug2-created'; // { id, repoPath } while waiting for the user to click Create
  const UPLOAD_TIMEOUT_MS = 120_000;

  const hashId = location.hash.match(/digitbug2=([\w-]+)/)?.[1];
  if (hashId) {
    sessionStorage.setItem(KEY, hashId);
    history.replaceState(null, '', location.pathname + location.search);
  }

  let banner;
  function say(text, tone = 'info') {
    if (!banner) {
      banner = document.createElement('div');
      banner.setAttribute('role', 'status');
      banner.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;'
        + 'max-width:640px;padding:10px 40px 10px 14px;border-radius:8px;font:14px/1.4 system-ui,sans-serif;'
        + 'box-shadow:0 4px 16px rgba(0,0,0,.25);color:#fff;';
      const close = document.createElement('button');
      close.textContent = '×';
      close.setAttribute('aria-label', 'Close');
      close.style.cssText = 'position:absolute;top:4px;right:8px;background:none;border:0;color:#fff;font-size:20px;cursor:pointer;';
      close.onclick = () => banner.remove();
      banner.append(document.createElement('span'), close);
      document.body.append(banner);
    }
    banner.style.background = { info: '#1d70b8', ok: '#00703c', warn: '#b54c00' }[tone];
    banner.firstChild.textContent = `DIGIT Bug Reporter v2: ${text}`;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(find, timeout = 15_000) {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(300)) {
      const el = find();
      if (el) return el;
    }
    return null;
  }

  const titleInput = () => document.querySelector(
    'input[name="issue[title]"], #issue_title, input[aria-label="Add a title"], input[aria-label="Title"], input[placeholder="Title"]');
  const bodyInput = () => document.querySelector(
    'textarea[name="issue[body]"], #issue_body, textarea[aria-label="Markdown value"], textarea[placeholder*="description" i], textarea[aria-label*="body" i]');

  // Replace the field's contents the way typing would, so GitHub's React state sees it.
  function setText(el, text) {
    el.focus();
    el.select();
    if (!document.execCommand('insertText', false, text)) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function fileInputNear(el) {
    for (let n = el; n; n = n.parentElement) {
      const input = n.querySelector('input[type=file]');
      if (input) return input;
    }
    return null;
  }

  const attachmentCount = (el) => (el.value.match(/user-attachments\/|githubusercontent\.com/g) || []).length;

  async function upload(textarea, file) {
    const before = attachmentCount(textarea);
    const dt = new DataTransfer();
    dt.items.add(file);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    const input = fileInputNear(textarea);
    if (input) {
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      textarea.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return waitFor(() => attachmentCount(textarea) > before, UPLOAD_TIMEOUT_MS);
  }

  const toFile = ({ name, type, base64 }) => {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type });
  };

  function offerDownload(files) {
    for (const f of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(toFile(f));
      a.download = f.name;
      a.textContent = ` Download ${f.name}`;
      a.style.cssText = 'color:#fff;text-decoration:underline;margin-left:6px;';
      banner.firstChild.after(a);
    }
  }

  // After Create, GitHub shows /<owner>/<repo>/issues/<number> in this tab.
  async function noteCreated() {
    let waiting;
    try { waiting = JSON.parse(sessionStorage.getItem(CREATED_KEY)); } catch { return; }
    const m = waiting && location.pathname.match(/^(\/[^/]+\/[^/]+)\/issues\/(\d+)\/?$/);
    if (!m || m[1].toLowerCase() !== waiting.repoPath.toLowerCase()) return;
    sessionStorage.removeItem(CREATED_KEY);
    const res = await chrome.runtime.sendMessage({ type: 'issue-created', id: waiting.id, url: `https://github.com${m[0]}` });
    say(res?.ok ? `issue #${m[2]} added to the bug tracker.` : `couldn't add issue #${m[2]} to the tracker (${res?.error}). Add it there by URL.`,
      res?.ok ? 'ok' : 'warn');
  }

  let busy = false;
  async function run() {
    const id = sessionStorage.getItem(KEY);
    if (!id || busy) return;
    if (/^\/(login|session|sessions)/.test(location.pathname)) {
      say('log in to GitHub. The report will be filled in after you\'re back on the new-issue page.', 'warn');
      return;
    }
    if (/\/issues\/new\/choose/.test(location.pathname)) {
      say('pick "Blank issue" (or the plain bug template). The report will be filled in on the next page.', 'warn');
      return;
    }
    if (!/\/issues\/new/.test(location.pathname)) return;

    busy = true;
    try {
      say('filling in the issue…');
      const [title, body] = [await waitFor(titleInput), await waitFor(bodyInput)];
      if (!title || !body) {
        say('couldn\'t find the title/description fields on this page. Use "Copy as Markdown" on the review page instead.', 'warn');
        return;
      }
      const res = await chrome.runtime.sendMessage({ type: 'github-payload', id });
      const payload = res?.payload;
      if (!payload) {
        say('the draft wasn\'t found. Open it again from the review page.', 'warn');
        return;
      }
      sessionStorage.removeItem(KEY); // fill once; a reload won't overwrite edits
      const repoPath = location.pathname.replace(/\/issues\/new.*$/, '');
      sessionStorage.setItem(CREATED_KEY, JSON.stringify({ id, repoPath }));

      setText(title, payload.title);
      setText(body, payload.body);

      const failed = [];
      for (const f of payload.files) {
        say(`uploading ${f.name}…`);
        if (!(await upload(body, toFile(f)))) failed.push(f);
      }
      // GitHub silently drops assignees from the URL if you lack triage/write access, so ask to check.
      const check = payload.assignees.length
        ? ` Check that ${payload.assignees.join(', ')} show under Assignees in the sidebar; set them there if not.` : '';
      if (failed.length) {
        say(`${failed.map((f) => f.name).join(', ')} didn't upload. Drag the file into the description, then click Create.${check}`, 'warn');
        offerDownload(failed);
      } else {
        say(`done.${check} Review the issue, then click Create yourself.`, 'ok');
      }
    } finally {
      busy = false;
    }
  }

  // GitHub navigates without full page loads (e.g. from the template chooser), so keep watching the URL.
  let lastHref = '';
  const watch = setInterval(() => {
    // after the extension is reloaded this copy is cut off; stop instead of throwing "Extension context invalidated"
    if (!chrome.runtime?.id) { clearInterval(watch); return; }
    if (location.href !== lastHref) { lastHref = location.href; noteCreated().catch(() => {}); run().catch(() => {}); }
  }, 1000);
})();
