// Read-only GitHub API lookups: repos, assignees and labels for the review page; issues, PRs and checks for the tracker.
// The token is optional; without it only public data can be listed.
const API = 'https://api.github.com';
export const DEFAULT_ORG = 'egovernments';
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export async function getToken() {
  const { githubToken } = await chrome.storage.local.get('githubToken');
  return githubToken || '';
}

export async function clearCache() {
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('cache:')));
}

export async function request(path, token, init = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(init.body && { 'Content-Type': 'application/json' }),
      },
    });
  } catch {
    throw new Error("couldn't reach GitHub; check your connection and reopen this page");
  }
  if (!res.ok) {
    if (res.status === 401) throw new Error('GitHub rejected the token. Check it in the extension settings.');
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('GitHub lookup limit reached for now. Connecting a token in settings raises it.');
    }
    throw new Error(`GitHub answered ${res.status} for ${path.split('?')[0]}`);
  }
  return { data: await res.json(), link: res.headers.get('link') };
}

async function paged(path, token, maxPages) {
  let out = [];
  for (let i = 0, next = path; i < maxPages && next; i++) {
    const { data, link } = await request(next, token);
    out = out.concat(data);
    next = link?.match(/<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/)?.[1];
  }
  return out;
}

// Cache in storage.local so reopening the review page doesn't repeat the lookups.
async function cached(key, ttl, load) {
  const k = `cache:${key}`;
  const { [k]: hit } = await chrome.storage.local.get(k);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  const value = await load();
  await chrome.storage.local.set({ [k]: { at: Date.now(), value } });
  return value;
}

export async function whoami(token) {
  const { data } = await request('/user', token);
  return data.login;
}

// With a token: every repo the account can open. Without: the org's public repos.
export function listRepos(token) {
  return cached(token ? 'repos:me' : `repos:${DEFAULT_ORG}`, DAY, async () => {
    const repos = token
      ? await paged('/user/repos?per_page=100&sort=pushed', token, 10)
      : await paged(`/orgs/${DEFAULT_ORG}/repos?per_page=100&type=public&sort=pushed`, '', 5);
    return repos.filter((r) => !r.archived && r.has_issues).map((r) => r.full_name);
  });
}

export function listAssignees(repo, token) {
  return cached(`assignees:${repo}`, HOUR, async () =>
    (await paged(`/repos/${repo}/assignees?per_page=100`, token, 5)).map((u) => u.login).sort((a, b) => a.localeCompare(b)));
}

export function listLabels(repo, token) {
  return cached(`labels:${repo}`, HOUR, async () =>
    (await paged(`/repos/${repo}/labels?per_page=100`, token, 3)).map((l) => l.name).sort((a, b) => a.localeCompare(b)));
}
