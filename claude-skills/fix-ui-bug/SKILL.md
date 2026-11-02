---
name: fix-ui-bug
description: Fix a UI bug reported as a GitHub issue on the DIGIT HCM console/workbench (DIGIT-Frontend): read the issue and its evidence, find the root cause, make the fix on a new branch in a separate git worktree, add tests, run them, and open a PR for the chosen reviewer, asking before editing code, pushing, and creating the PR. Started from the DIGIT Bug Reporter tracker ("Fix UI issue"), or when the user says "fix this UI issue", "fix issue #1234", or pastes a DIGIT-Frontend issue URL and asks for a fix.
---

# Fixing a UI bug from a GitHub issue

```
claude --chrome "/fix-ui-bug <issue-url> repo=<owner/name> [reviewer=<login>] [base=<branch>]"
```
The DIGIT Bug Reporter tracker builds this command (Fix UI issue → Copy command). `repo` is where the code change
goes. It may differ from the repo the issue was filed in. Without `reviewer`, ask for one at the PR step. Without
`base`, choose it in step 3.

## Ground rules
- **Three approvals, each for this issue only:** (1) the root cause and planned change, before editing any file;
  (2) the diff and test results, before committing and pushing; (3) the PR text, before creating the PR. A "yes" to
  one is not a yes to the next.
- **Never touch the user's checkout.** Work in a new `git worktree`. The clones in `/home/egov` often have
  unfinished work on other branches.
- **Never merge, force-push, rebase shared branches, or push to the base branch.** Only push the new `fix/` branch.
- **Read-only on shared environments** (demo/uat/qa): reproduce and look, but never click Save/Submit/Create/Delete,
  and make no MDMS writes. Global CLAUDE.md rules apply.
- Keep the change minimal and on-topic: no drive-by refactors or formatting of untouched lines.
- Report facts. If a test fails or a step is skipped, say so in the summary and in the PR.

## Procedure

1. **Read the issue.** Use `curl -s https://api.github.com/repos/<r>/issues/<n>` and `/comments`. Add
   `-H "Authorization: Bearer $GITHUB_TOKEN"` if that variable is set (the `gh` CLI is not installed). Note the
   environment line (host, tenant, campaign, **UI build** `digit-ui.<hash>.bundle.js`), the steps, expected/actual,
   and the failing calls and console errors. Look at the screenshot and video: open the issue in Chrome, or download
   `user-attachments` images into the scratchpad and read them.

2. **Decide whether it's a code bug.** Before blaming the code, rule out an MDMS/config cause, the 1 h localStorage
   cache, and a backend 4xx/5xx (the `qa-bug-triage` agent and the `app-config-check` skill cover these). If it is
   config or backend, stop: tell the user, suggest a comment on the issue, and don't write a UI fix.

3. **Set up a worktree.**
   - Find the clone: `git -C /home/egov/<dir> remote get-url origin` matching `repo` (for DIGIT-Frontend:
     `/home/egov/DIGIT-Frontend`).
   - `git -C <clone> fetch origin`. If `base` wasn't given, use the repo's default branch
     (`git -C <clone> remote show origin | sed -n 's/.*HEAD branch: //p'`) unless the issue points at another line
     of work, e.g. a console feature branch that is deployed to the environment. State the choice and why.
   - `git -C <clone> worktree add /home/egov/<repo>-fix-<n> -b fix/<n>-<short-slug> origin/<base>`.

4. **Reproduce and find the root cause.** If the steps can be followed read-only, follow them in Chrome and capture a
   screenshot. Find the code from the page route in the URL (e.g. `/workbench-ui/employee/campaign/...` →
   `health/micro-ui/web/micro-ui-internals/packages/modules/campaign-manager`). Search for the component, the
   i18n keys shown on screen, and the failing API path. Name the exact cause as `file:line` and the condition that
   goes wrong.

5. **Approval 1: plan.** Show the root cause, the files you will change, the planned change in a few lines, and the
   tests you will add. Ask: **go ahead / change the plan / stop**. For design-system components and styling, follow
   the `digit-design-system` skill.

6. **Fix and test** in the worktree.
   - Make the change.
   - Tests: look for a runner in the package and the repo root (`jest`, `vitest`, `react-scripts test`, `test`
     scripts in `package.json`). If one exists, add a test beside the code in its style that fails before the fix and
     passes after. If none exists (most HCM UI modules), move the faulty logic into a small pure function and test
     it with `node --test` (no new dependencies). Never add a test framework or change `package.json`/lockfiles
     without asking.
   - Run the new tests, then the package's existing tests, and lint/build the changed package if it has a script for
     that (regression check). Keep the exact commands and pass/fail counts. Show any failures as they are, and don't
     disable or delete tests to get green.

7. **Approval 2: diff and results.** Show `git -C <worktree> diff --stat` plus the full diff, the test commands and
   results, and anything that still fails. Ask: **commit and push the branch / change something / stop**. On yes,
   commit (`Fix <screen>: <what> (#<n>)`, with the Co-Authored-By trailer from the system reminder) and run
   `git push -u origin fix/<n>-<slug>`. If the push is rejected for permissions, stop and say so. Don't try a fork
   without asking.

8. **Approval 3: PR.** Draft the PR text and save it to `<scratchpad>/pr-<n>.md`:
   ```
   Fixes <issue-url or #n>

   ## Root cause
   <file:line and the condition, 2-4 sentences>
   ## Changes
   - <file>: <what and why>
   ## Tests added
   - <test file>: <what it covers>
   ## Test results
   <commands, pass/fail counts; remaining failures and whether they also fail on the base branch>
   ## Evidence
   <before screenshot from the issue / reproduction; after: test output, or a screenshot from a local run if one was done>
   ```
   Show it with the reviewer and the base branch, then ask: **create PR / change something / stop**. On yes:
   - With `$GITHUB_TOKEN`: `POST /repos/<repo>/pulls` (head `fix/...`, base `<base>`), then
     `POST /repos/<repo>/pulls/<pr>/requested_reviewers` with the reviewer, and `POST /repos/<repo>/issues/<pr>/assignees`
     to assign it to them as owner.
   - Without a token: open `https://github.com/<repo>/compare/<base>...fix/<n>-<slug>?expand=1&title=<urlencoded>&body=<urlencoded>`
     in Chrome. The user reviews it, clicks **Create pull request**, and picks the reviewer in the sidebar.

9. **Hand back.** Report the PR URL, the branch, the worktree path (they can remove it later with
   `git -C <clone> worktree remove <path>` once the PR is merged) and the test summary. The tracker links the PR on
   its next sync, because the PR body mentions the issue. Tell the user to press **Sync now** to see it at once.
   Never merge the PR.
