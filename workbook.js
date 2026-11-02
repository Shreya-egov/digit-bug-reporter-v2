// The tracker as an Excel workbook: a "Bugs" sheet with one row per bug and a "Summary" sheet whose counts are
// formulas over the Bugs sheet, so they stay right if rows are edited or added in Excel. Can be downloaded, or
// written to a linked file that is rewritten whenever the tracker changes (see writeLinked).
import * as db from './db.js';
import { colName, xlsx } from './xlsx.js';
import { SEVERITIES, STATUSES, fixStatusOf, fixedAtOf, parseIssueUrl, parsePrUrl, statusOf } from './bugs.js';

const COLUMNS = [
  ['Issue ID', 14], ['Bug title', 50], ['Environment', 12], ['Repository', 32], ['Bug type', 13], ['Severity', 10],
  ['Priority', 9], ['GitHub issue URL', 18], ['Assigned owner', 22], ['Fix status', 13], ['PR URL', 14], ['Reviewer', 18],
  ['Test status', 11], ['Date reported', 13], ['Date fixed', 12], ['Date verified', 13], ['Current status', 18],
];
const col = (name) => colName(COLUMNS.findIndex(([h]) => h === name));
const RANGE_END = 5000; // formulas cover rows added later in Excel too

const date = (ms) => (ms ? new Date(ms) : null);
const link = (url, text) => (url ? { f: `HYPERLINK("${url}","${text.replace(/"/g, '""')}")`, v: text } : '');

function bugRow(b) {
  const issue = parseIssueUrl(b.issueUrl);
  const pr = parsePrUrl(b.prUrl);
  return [
    issue ? `${issue.repo.split('/')[1]}#${issue.number}` : 'draft', b.title || '', b.env || '', b.repo || '', b.type || '',
    b.severity || '', b.priority || '', link(b.issueUrl, b.issueUrl ? `#${issue?.number ?? 'issue'}` : ''),
    (b.assignees || []).join(', '), fixStatusOf(b), link(b.prUrl, pr ? `#${pr.number}` : 'PR'), b.reviewer || '',
    b.testStatus || 'Not run', date(b.reportedAt), date(fixedAtOf(b)), date(b.verifiedAt), statusOf(b),
  ];
}

// "label | count" rows; count is COUNTIF over a Bugs column, with the value computed here as the cached result.
function countRows(rows, column, values, field) {
  const range = `Bugs!$${col(column)}$2:$${col(column)}$${RANGE_END}`;
  return values.map((v) => [v, { f: `COUNTIF(${range},"${v.replace(/"/g, '""')}")`, v: rows.filter((b) => field(b) === v).length }]);
}

const distinct = (rows, field) => [...new Set(rows.map(field).filter(Boolean))].sort();

export function buildWorkbook(rows) {
  rows = [...rows].sort((a, b) => (b.reportedAt || 0) - (a.reportedAt || 0));
  const status = `Bugs!$${col('Current status')}$2:$${col('Current status')}$${RANGE_END}`;
  const fix = `Bugs!$${col('Fix status')}$2:$${col('Fix status')}$${RANGE_END}`;
  const count = (range, v, actual) => ({ f: `COUNTIF(${range},"${v}")`, v: actual });
  const by = (s) => rows.filter((b) => statusOf(b) === s).length;
  const inProgress = by('In progress') + by('In review');

  // Owners are counted here rather than with a formula: a bug can have several, joined in one cell.
  const owners = new Map();
  for (const b of rows) for (const a of (b.assignees?.length ? b.assignees : ['(unassigned)'])) owners.set(a, (owners.get(a) || 0) + 1);

  const summary = [
    [{ v: 'DIGIT HCM bug tracker', bold: true }, `Exported ${new Date().toLocaleString()}`],
    [],
    [{ v: 'Metric', bold: true }, { v: 'Count', bold: true }],
    ['Total bugs reported', { f: `COUNTA(Bugs!$${col('Bug title')}$2:$${col('Bug title')}$${RANGE_END})`, v: rows.length }],
    ['Open bugs', count(status, 'Open', by('Open'))],
    ['Bugs in progress (incl. in review)', { f: `COUNTIF(${status},"In progress")+COUNTIF(${status},"In review")`, v: inProgress }],
    ['Bugs fixed (not yet verified)', count(status, 'Fixed', by('Fixed'))],
    ['Bugs verified and closed', count(status, 'Verified & closed', by('Verified & closed'))],
    ['PRs awaiting review', count(fix, 'PR open', rows.filter((b) => fixStatusOf(b) === 'PR open').length)],
    [],
    [{ v: 'By current status', bold: true }, { v: 'Count', bold: true }],
    ...countRows(rows, 'Current status', STATUSES, statusOf),
    [],
    [{ v: 'By repository', bold: true }, { v: 'Count', bold: true }],
    ...countRows(rows, 'Repository', distinct(rows, (b) => b.repo), (b) => b.repo),
    [],
    [{ v: 'By environment', bold: true }, { v: 'Count', bold: true }],
    ...countRows(rows, 'Environment', distinct(rows, (b) => b.env), (b) => b.env),
    [],
    [{ v: 'By severity', bold: true }, { v: 'Count', bold: true }],
    ...countRows(rows, 'Severity', SEVERITIES, (b) => b.severity),
    [],
    [{ v: 'By owner (as of export)', bold: true }, { v: 'Count', bold: true }],
    ...[...owners].sort((a, b) => b[1] - a[1]).map(([who, n]) => [who, n]),
  ];

  return xlsx([
    { name: 'Summary', widths: [36, 28], rows: summary },
    { name: 'Bugs', widths: COLUMNS.map(([, w]) => w), header: true, filter: true, rows: [COLUMNS.map(([h]) => h), ...rows.map(bugRow)] },
  ]);
}

// ---- linked workbook: a file the user picked once, rewritten from the tracker page ----
export const linkedHandle = () => db.meta.get('workbookHandle');

export async function linkWorkbook() {
  const handle = await window.showSaveFilePicker({
    suggestedName: 'DIGIT-HCM-bug-tracker.xlsx',
    types: [{ description: 'Excel workbook', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } }],
  });
  await db.meta.set('workbookHandle', handle);
  return handle;
}

export const unlinkWorkbook = () => db.meta.remove('workbookHandle');

// Returns 'written', 'none' (no file linked) or 'needs-permission' (Chrome asks again after a restart, and only
// on a click, so the tracker page shows a button for it). ask=true is for that click.
export async function writeLinked(rows, ask = false) {
  const handle = await linkedHandle();
  if (!handle) return 'none';
  const mode = { mode: 'readwrite' };
  let perm = await handle.queryPermission(mode);
  if (perm !== 'granted' && ask) perm = await handle.requestPermission(mode);
  if (perm !== 'granted') return 'needs-permission';
  const out = await handle.createWritable();
  await out.write(buildWorkbook(rows));
  await out.close();
  await db.meta.set('workbookWrittenAt', Date.now());
  return 'written';
}
