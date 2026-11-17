// Runs in the DIGIT page's own JS world from document_start. Records every API call (fetch and XHR, with the request
// body and a capped copy of the response), console errors and the user's clicks/navigation, and hands them to
// relay.js. The review page lists the calls so the reporter picks which ones go into the issue, each with a curl.
// The auth token and user details in RequestInfo are replaced by a placeholder here, before anything leaves the
// page; login requests are never recorded with their body; what is typed into text fields is never recorded.
// Also keeps the MDMS records the page loads (config, not personal data), which background.js reads when capture
// stops. They go only to the local automatic diagnosis, never into the GitHub issue.
(() => {
  if (window.__digitBugV2Hook) return;
  window.__digitBugV2Hook = true;

  const post = (event) => {
    try {
      window.postMessage({ __digitBugV2: 1, event: { ts: Date.now(), ...event } }, location.origin);
    } catch { /* page navigating away */ }
  };
  const short = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

  const pathOf = (url) => {
    try {
      const u = new URL(url, location.href);
      return (u.origin === location.origin ? '' : u.host) + u.pathname + u.search;
    } catch { return short(url, 200); }
  };

  // DIGIT services answer with { Errors: [{ code, message }] }; keep just that.
  const errorSummary = (text) => {
    try {
      const j = JSON.parse(text);
      const errs = j.Errors || j.errors;
      if (Array.isArray(errs) && errs.length) {
        return short(errs.slice(0, 3).map((e) => [e.code, e.message].filter(Boolean).join(': ')).join(' | '), 400);
      }
      if (j.message || j.error) return short(j.message || j.error);
    } catch { /* not JSON */ }
    // gateway error pages (504 Gateway Time-out, 502 Bad Gateway) are HTML; their title says it all
    const title = /<title>([^<]*)<\/title>|<h1>([^<]*)<\/h1>/i.exec(text);
    if (title) return short(title[1] || title[2]);
    return short(text, 200);
  };

  const safeBodyText = (body) => {
    if (body == null) return '';
    if (typeof body === 'string') return body;
    try { return JSON.stringify(body); } catch { return String(body); }
  };

  // Kept per call so a few hundred calls fit in the extension's session storage; MDMS and localization answers are huge.
  const MAX_TEXT = 4000;
  const cap = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (truncated, ${s.length} characters in all)` : s);

  const LOGIN_RE = /\/user\/oauth\/token|\/_login|\/otp\//i;
  const TOKEN_PLACEHOLDER = '<your-auth-token>';

  // Request body for the curl. DIGIT sends RequestInfo (auth token, user details) in every body: swap it for a
  // placeholder the reader fills with their own token.
  const requestBody = (url, body) => {
    if (body == null || body === '') return '';
    if (LOGIN_RE.test(url)) return '<login request: body not recorded>';
    if (typeof FormData !== 'undefined' && body instanceof FormData) return '<multipart form data: not recorded>';
    if (typeof Blob !== 'undefined' && body instanceof Blob) return '<file upload: not recorded>';
    if (body instanceof ArrayBuffer || ArrayBuffer.isView?.(body)) return '<binary body: not recorded>';
    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) body = body.toString();
    if (typeof body !== 'string') return '<body not recorded>';
    try {
      const j = JSON.parse(body);
      if (j && typeof j === 'object') {
        for (const k of ['RequestInfo', 'requestInfo']) if (k in j) j[k] = { apiId: 'Rainmaker', authToken: TOKEN_PLACEHOLDER };
        return cap(JSON.stringify(j));
      }
    } catch { /* not JSON */ }
    return cap(body);
  };

  const emitNetwork = (info, status, text, failText) => {
    const response = safeBodyText(text).trim();
    const failed = !status || status >= 400;
    post({
      kind: 'network',
      ...info,
      status,
      ms: info.start ? Math.round(performance.now() - info.start) : undefined,
      start: undefined,
      error: failed ? (failText || (status ? errorSummary(response) : 'request failed (network error, CORS or aborted)')) : '',
      response: cap(response),
    });
  };

  // MDMS v2 search responses: newest copy of each record wins; oldest dropped beyond the size cap.
  const MDMS_RE = /\/(mdms[\w-]*|egov-mdms-service)\/v2\/_search/;
  const MDMS_MAX_RECORD = 1_500_000;
  const MDMS_MAX_TOTAL = 6_000_000;
  const mdms = new Map();
  let mdmsBytes = 0;
  const keepMdms = (text) => {
    let res;
    try { res = JSON.parse(text); } catch { return; }
    for (const r of Array.isArray(res?.mdms) ? res.mdms : []) {
      if (!r?.schemaCode || !r.uniqueIdentifier) continue;
      const json = JSON.stringify({
        schemaCode: r.schemaCode, uniqueIdentifier: r.uniqueIdentifier, tenantId: r.tenantId, isActive: r.isActive,
        lastModifiedTime: r.auditDetails?.lastModifiedTime, data: r.data,
      });
      if (json.length > MDMS_MAX_RECORD) continue;
      const key = `${r.schemaCode}|${r.uniqueIdentifier}`;
      if (mdms.has(key)) mdmsBytes -= mdms.get(key).length;
      mdms.delete(key); // re-insert so it counts as newest
      mdms.set(key, json);
      mdmsBytes += json.length;
      while (mdmsBytes > MDMS_MAX_TOTAL) {
        const [oldest, value] = mdms.entries().next().value;
        mdms.delete(oldest);
        mdmsBytes -= value.length;
      }
    }
  };
  window.__digitBugV2Mdms = () => [...mdms.values()];

  const fmt = (a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  };

  // console errors and uncaught exceptions
  const origError = console.error;
  console.error = function (...args) {
    post({ kind: 'console', text: short(args.map(fmt).join(' '), 500) });
    return origError.apply(this, args);
  };
  window.addEventListener('error', (e) => {
    if (e.message) post({ kind: 'console', text: short(`Uncaught ${e.message} (${pathOf(e.filename || '')}:${e.lineno})`, 500) });
  });
  window.addEventListener('unhandledrejection', (e) => {
    post({ kind: 'console', text: short(`Unhandled rejection: ${fmt(e.reason)}`, 500) });
  });

  // fetch
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const url = pathOf(typeof input === 'string' ? input : input?.url ?? String(input));
    const info = { method, url, body: requestBody(url, init?.body), start: performance.now() };
    try {
      const res = await origFetch.apply(this, arguments);
      res.clone().text()
        .then((t) => {
          if (res.status < 400 && MDMS_RE.test(url)) keepMdms(t);
          emitNetwork(info, res.status, t, res.status >= 400 ? errorSummary(t) : '');
        })
        .catch(() => emitNetwork(info, res.status, '', ''));
      return res;
    } catch (err) {
      emitNetwork(info, 0, '', short(err?.message));
      throw err;
    }
  };

  // XMLHttpRequest (axios, which the DIGIT UI uses)
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__digitBugV2 = { method: String(method).toUpperCase(), url: pathOf(url) };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__digitBugV2;
    if (info) {
      info.body = requestBody(info.url, body);
      info.start = performance.now();
      this.addEventListener('loadend', () => {
        let text = '';
        try {
          if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
          else if (this.responseType === 'json') text = JSON.stringify(this.response);
        } catch { /* unreadable body */ }
        if (this.status && this.status < 400 && MDMS_RE.test(info.url)) keepMdms(text);
        emitNetwork(info, this.status, text, this.status >= 400 ? errorSummary(text) : '');
      });
    }
    return origSend.apply(this, arguments);
  };

  // user actions, for the repro steps
  const labelOf = (el) => short(
    el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.value || '', 60);

  const fieldName = (el) => short(
    el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.placeholder || el.name || el.id || el.tagName.toLowerCase(), 60);

  const CLICKABLE = 'button,a,summary,label,[role=button],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=link]';

  // DIGIT dropdowns are plain divs, so fall back to the nearest element with a pointer cursor.
  const clickTarget = (t) => {
    const el = t.closest(CLICKABLE);
    if (el) return el;
    for (let n = t, i = 0; n && n !== document.body && i < 4; n = n.parentElement, i++) {
      if (getComputedStyle(n).cursor === 'pointer') return n;
    }
    return null;
  };

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || t.closest('input[type=text],input:not([type]),textarea,[contenteditable=true]')) return;
    const el = clickTarget(t);
    const text = el && labelOf(el);
    if (text) post({ kind: 'action', text: `Click "${text}"` });
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    const name = fieldName(el);
    let text;
    if (el.tagName === 'SELECT') text = `Select "${short(el.selectedOptions?.[0]?.text, 60)}" in "${name}"`;
    else if (el.type === 'checkbox' || el.type === 'radio') text = `${el.checked ? 'Tick' : 'Untick'} "${name}"`;
    else if (el.type === 'file') text = `Upload a file in "${name}"`;
    else text = `Fill in "${name}"`;
    post({ kind: 'action', text });
  }, true);

  // SPA navigation
  let lastPath = '';
  const nav = () => {
    const p = location.pathname + location.search;
    if (p !== lastPath) { lastPath = p; post({ kind: 'nav', url: p }); }
  };
  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function () { const r = orig.apply(this, arguments); nav(); return r; };
  }
  window.addEventListener('popstate', nav);
  nav();

  document.addEventListener('DOMContentLoaded', () => {
    let tenant = null;
    try { tenant = localStorage.getItem('Employee.tenant-id'); } catch { /* storage blocked */ }
    if (tenant) post({ kind: 'meta', tenant: short(tenant, 40) });
  });
})();
