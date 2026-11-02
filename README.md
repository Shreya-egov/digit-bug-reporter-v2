# DIGIT Bug Reporter v2 (Chrome extension)

> **v2 can be installed next to v1** ([digit-bug-reporter](https://github.com/Shreya-egov/digit-bug-reporter)) for side-by-side
> testing. It has its own name, a teal **v2** toolbar icon, the shortcut **Alt+Shift+V** (v1 keeps Alt+Shift+B), and its own
> storage. Its capture and GitHub filling use separate markers, so neither version picks up the other's reports.

Record a bug on the DIGIT HCM console the way you would with a screen recorder. When you press **Stop**, the
extension opens a review page with the video, a screenshot, the steps drafted from your clicks, and the failing API
calls and console errors, already redacted. After you review it, **Open on GitHub** fills in the new-issue form and
uploads the media. You click **Create**.

Each issue then goes into a **bug tracker** that follows it on GitHub: the PR that fixes it, the reviewer, the
checks, and your verification. The tracker exports to Excel. For UI bugs, **Fix UI issue** hands the issue to
Claude Code. Claude checks both the MDMS config the screen loads and the DIGIT-Frontend code, and fixes whichever is
wrong: MDMS through a backed-up, diffed update; code on a new branch with tests and a PR for the reviewer you pick. It
asks you before each change.

## Install (once)
1. Get the code:
   ```bash
   git clone https://github.com/Shreya-egov/digit-bug-reporter-v2.git
   ```
   or download it as a ZIP from GitHub (**Code → Download ZIP**) and unzip it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `digit-bug-reporter-v2` folder.
4. Pin the extension: click the puzzle icon in the toolbar, then the pin next to **DIGIT Bug Reporter v2**.
5. Reload any DIGIT tabs that are already open, so that capture starts on them.
6. Optional, for **Fix UI issue**: install the Claude Code skill once:
   ```bash
   mkdir -p ~/.claude/skills && ln -s "$PWD/claude-skills/fix-ui-bug" ~/.claude/skills/fix-ui-bug
   ```
   (run it in the extension folder).

## Use
1. On the DIGIT page, click the extension icon (or press **Alt+Shift+V**) and choose what to capture:
   **Video + screenshot**, **Video only** or **Screenshot only**. The popup remembers your choice.
2. Click **● Start recording** and reproduce the bug. Recording stops by itself after 2 minutes.
   With **Screenshot only**, click **📷 Take screenshot** instead; the review page opens straight away.
3. Click the icon again, then **■ Stop & review**.
4. On the review page:
   - Pick the **repository** (click to see all, or type to search), then optionally the **assignees** for that
     repo. Each new report starts with nobody assigned.
   - Optionally pick **labels** from the repo's own labels.
   - Write the title, the preconditions, the expected result and the actual result. Set the bug type, severity and
     priority.
   - Check the drafted steps, and add the values you typed. Typed text is never recorded.
   - Watch the video. Tick the box confirming that no personal data is visible.
5. Click **Open on GitHub**. Wait for the "done" banner, check the issue, then click **Create**. The banner then
   says the issue was added to the bug tracker.

Other options: **Copy as Markdown** for Jira or Slack, **Download video**, and **Discard**.

## Bug tracker
Open it from the popup (**Bug tracker**) or the link on the review page. It lists every issue opened from the
review page, plus any issue you add with **Add issue by URL**, such as bugs filed with the `github-bug` skill or by
hand. For those, environment, severity and priority are read from the issue body when it uses this extension's
format.

- **Synced from GitHub** every 30 minutes and on **Sync now**: issue state and assignees, the PR that mentions the
  issue (or one you set by hand), its reviewer, and its checks (**Tests**: Passed/Failed/Running).
  GitHub only reveals a PR attached in the issue's **Development** sidebar (one that doesn't mention the issue) to a
  token. Without one, the PR column says "linked (token needed)".
- **Set by you** in a bug's **Open** dialog: type, severity, priority, environment, reviewer, test status, PR URL,
  MDMS change, **Mark fix in progress**, **Mark fixed by MDMS change** and **Mark verified**. Verifying is allowed once the fix is merged or the issue is closed
  as completed.
- **Status** follows the bug through: Draft → Open → In progress → In review (PR open) → Fixed (PR merged) →
  Verified → Verified & closed. A bug fixed in MDMS is Fixed as soon as you mark it, even if a code PR is still open. "Closed (not planned)" is for issues closed without a fix.
- **Log:** each bug's dialog lists what changed and when: status, fix, tests, edits, and the fix command.
- Tiles at the top show total, open, in progress, fixed, verified & closed, and PRs awaiting review. Below them are
  counts by repository, environment, severity and owner.

### Excel
- **Download Excel** saves `DIGIT-HCM-bug-tracker-<date>.xlsx`. The **Bugs** sheet has one row per bug: issue ID,
  title, environment, repository, type, severity, priority, issue link, owner, fix status, PR link, reviewer, test
  status, dates reported/fixed/verified, and current status. The **Summary** sheet has the metrics and breakdowns as
  `COUNTIF` formulas over the Bugs sheet, so they stay right if you edit rows in Excel. The owner breakdown is a
  snapshot.
- **Link a workbook file…** picks a file once (for a shared copy, put it in a synced OneDrive/Drive folder). The
  tracker rewrites it whenever something changes **while the tracker page is open**. After a Chrome restart, Chrome
  asks again: press **Update workbook**. Close the file in Excel first, since Excel locks files it has open. Edits
  made in the linked file are overwritten: the tracker is the source, and the workbook is a copy of it.

## Fixing a UI bug with Claude Code
In the tracker, open a bug that has a GitHub issue and click **Fix UI issue…**:
1. Check the **repository to fix**. It defaults to DIGIT-Frontend for UI bugs, even when the issue was filed in the
   services repo.
2. Pick the **reviewer/owner** from the people who can be assigned in that repo. Optionally give a **base branch**.
3. Click **Copy command and mark in progress** and paste the command into a terminal, for example:
   `claude --chrome "/fix-ui-bug https://github.com/egovernments/DIGIT-Frontend/issues/1234 repo=egovernments/DIGIT-Frontend reviewer=someone"`

Claude Code (the `fix-ui-bug` skill, see Install step 6) reads the issue and its screenshots, and reproduces the bug
read-only. It then checks **both sides** before changing anything:
- **MDMS config:** reads the records the screen loads (FormConfig, templates, masters, localisation) through the
  `mdms-qa` and `app-config-check` skills. This is read-only, with no unfiltered searches on qa. It compares them
  with the template, with a campaign or env where the screen works, and with what the code expects.
- **Frontend code:** follows how DIGIT-Frontend reads and renders that data, without touching your checkout.

It then tells you which side is wrong (data, code, or both, e.g. bad data the code should also have tolerated) and
asks what to fix:
- **MDMS fix:** backup → diff → your **yes for each record** → write as your own user → re-check in incognito. A
  config fix has no PR, so afterwards fill in **MDMS change** on the bug in the tracker and click **Mark fixed by MDMS
  change**. It counts as Fixed and appears in the Excel "MDMS change" column.
- **Code fix:** a **new git worktree on a new `fix/` branch**, with tests that use the real MDMS record as the
  fixture. It asks before committing and pushing, and again before creating the PR (issue link, root cause, changes,
  tests, results, related config change, evidence) and requesting the reviewer. The PR mentions the issue, so the
  tracker picks it up on the next sync.

It never merges.

A browser extension can't edit code, run tests or push, which is why this part runs in Claude Code and not in
Chrome.

## Automatic diagnosis of new frontend bugs
`automation/auto-triage.sh` diagnoses each new DIGIT-Frontend issue you file (from the extension or by hand) without
you starting it, and changes nothing.

- Every 15 minutes (systemd user timer) it looks for new open issues in `egovernments/DIGIT-Frontend` that you
  opened in the last 2 days. It diagnoses at most 3 per run.
- For each one, Claude Code runs `fix-ui-bug` in **diagnose mode**: issue and screenshots, deployed build, MDMS records
  (read-only), and the code. It writes `~/digit-bug-triage/DIGIT-Frontend-<n>/`:
  - `report.md`: the first line is the verdict (MDMS data / code / both / backend / ...), followed by the evidence;
  - `comment.md`: a draft comment for the issue;
  - `mdms/`: the backup and dry-run diff of any proposed MDMS change.
- You get a desktop notification with the verdict.

It is **read-only by construction**:
- **Permissions:** the run uses an allowlist of read commands, and anything else is denied because nobody is there to
  approve it.
- **MDMS:** diffs go through `mdms-dryrun.sh`, which has no apply path.
- **Network:** GitHub reads go through `gh-get.sh`, which can only send GET requests to api.github.com, and the GitHub
  token is removed from the run's environment.
- **Files:** it can only write inside the report folder.

Issue text is treated as data. To apply a fix, run the normal interactive `/fix-ui-bug`, which asks for your yes at
each write.

```bash
automation/auto-triage.sh https://github.com/egovernments/DIGIT-Frontend/issues/1234   # one issue, now
automation/install.sh            # turn on the 15-minute timer
automation/install.sh --remove   # turn it off
```
Settings (environment variables): `DIGIT_TRIAGE_AUTHOR` (default: your git user.name), `DIGIT_TRIAGE_REPO`,
`DIGIT_TRIAGE_OUT`, `DIGIT_TRIAGE_SINCE_DAYS`, `DIGIT_TRIAGE_MAX`. Each diagnosis is a full Claude Code run and uses
your Claude usage. The timer only runs while you're logged in to this machine.

## Connecting GitHub (optional)
Without a token the review page lists the public `egovernments` repos and the people who can be assigned in the
chosen repo. GitHub allows about 60 such lookups an hour without a token; lists are cached, so reopening a report
doesn't repeat them.

The tracker uses the same lookups: about four per open bug on each sync. Without a token, the hourly limit covers
roughly 15 bugs, so connect a token if you track more than that.

A token adds the private repos your account can open and a much higher limit. Open the extension's **Settings**
(right-click the icon → *Options*, or the **Connect GitHub** link on the review page), paste a token and click
**Save and test**. The settings page explains which read-only permissions it needs. The token stays in your Chrome
profile and is only used to read: repo, people and label lists, and issue, PR and check status for the tracker.

Assignees and labels are passed to GitHub in the new-issue link. GitHub applies them only if you have triage or
write access to the repo; otherwise set them in the issue sidebar.

## What is captured
- **Captured:** failing API calls (method, path, status, and the DIGIT `Errors[].code/message`); console errors;
  button and option clicks; select and checkbox changes; page changes; the tenant; the deployed UI build (the
  hashed `digit-ui.<hash>.bundle.js` name, which changes with every deploy); Chrome version and OS.
  Events start 1 minute before you press Start, so errors from page load are included.
- **Never captured:** request bodies (they contain the auth token), what you type into text fields, and audio.
- **Redaction:** tokens, JWTs, passwords, OTPs, phone numbers, emails, personal-data fields and non-essential query
  parameters are masked automatically. Free text and the video can't be redacted, so check them before filing.
- **Storage:** only the last 10 reports (with their video) are kept, in the extension's own storage. Tracker rows
  are small and are kept until you remove them.

## Limits
- The UI build is the bundle hash, not the image tag. To get the image tag, run
  `~/.claude/skills/github-bug/scripts/envinfo.sh <page url>` (kubectl, read-only).
- The tracker only notices **Create** when the issue is created in the tab the extension opened. For anything
  else, use **Add issue by URL**.
- GitHub's video limit is 10 MB on free plans. Two minutes is about 9 MB. The review page warns you if a video is larger.
- If the repository shows a template chooser, pick **Blank issue**. If the upload fails, the banner gives you a
  download link so you can drag the file in yourself.
- Capture works on `*.digit.org` tabs only.

## Updating
`git pull` in the folder (or download the ZIP again), then click the reload icon (↻) on **DIGIT Bug Reporter v2** in
`chrome://extensions`. Updating from 0.1 keeps your saved reports.
