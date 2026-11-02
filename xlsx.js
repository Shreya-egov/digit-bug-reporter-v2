// Minimal .xlsx writer, so the extension needs no spreadsheet library. Supports text, numbers, dates, booleans
// and formulas (with a cached value, recalculated when the file opens), a bold header row, frozen panes,
// an autofilter and column widths. Files are zipped without compression.
//
// xlsx([{ name, widths: [chars...], rows: [[cell...]], header: true, filter: true }]) → Blob
// cell: null | string | number | boolean | Date | { f: 'SUM(A1:A3)', v: cachedValue } | { v, bold: true }

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const STYLE = { normal: 0, bold: 1, date: 2, wrap: 3 };

// Strip characters XML 1.0 doesn't allow, then escape.
const esc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const excelDate = (d) => d.getTime() / 86_400_000 + 25_569 - d.getTimezoneOffset() / 1440;

function cellXml(cell, ref, bold) {
  if (cell == null || cell === '') return '';
  const s = (style) => (style ? ` s="${style}"` : '');
  if (cell instanceof Date) return `<c r="${ref}"${s(STYLE.date)}><v>${excelDate(cell)}</v></c>`;
  if (typeof cell === 'object' && 'f' in cell) {
    const v = cell.v;
    const cached = v == null ? '' : typeof v === 'number' ? `<v>${v}</v>` : `<v>${esc(v)}</v>`;
    return `<c r="${ref}"${s(bold ? STYLE.bold : 0)}${typeof v === 'number' ? '' : ' t="str"'}><f>${esc(cell.f)}</f>${cached}</c>`;
  }
  if (typeof cell === 'object') return cellXml(cell.v, ref, cell.bold);
  if (typeof cell === 'number') return `<c r="${ref}"${s(bold ? STYLE.bold : 0)}><v>${cell}</v></c>`;
  if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
  const text = String(cell);
  const style = bold ? STYLE.bold : text.includes('\n') ? STYLE.wrap : 0;
  return `<c r="${ref}"${s(style)} t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

function sheetXml({ rows, widths = [], header = false, filter = false }) {
  const lastCol = colName(Math.max(1, ...rows.map((r) => r.length)) - 1);
  const views = header
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '';
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((c, i) => cellXml(c, `${colName(i)}${r + 1}`, header && r === 0)).join('')}</row>`).join('');
  const auto = filter && rows.length ? `<autoFilter ref="A1:${lastCol}${rows.length}"/>` : '';
  return `${XML_HEAD}<worksheet xmlns="${NS}" xmlns:r="${REL_NS}">${views}${cols}<sheetData>${body}</sheetData>${auto}</worksheet>`;
}

const STYLES = `${XML_HEAD}<styleSheet xmlns="${NS}">`
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>'
  + '</styleSheet>';

function workbookFiles(sheets) {
  const n = sheets.length;
  const filters = sheets.map((sh, i) => (sh.filter && sh.rows.length
    ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${sh.name.replace(/'/g, "''")}'!$A$1:$${colName(Math.max(...sh.rows.map((r) => r.length)) - 1)}$${sh.rows.length}</definedName>`
    : '')).join('');
  return {
    '[Content_Types].xml': `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>',
    '_rels/.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `${XML_HEAD}<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><sheets>`
      + sheets.map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + `</sheets>${filters ? `<definedNames>${filters}</definedNames>` : ''}<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${n + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLES,
    ...Object.fromEntries(sheets.map((sh, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sh)])),
  };
}

// ---- zip (stored, no compression) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(10, 0, true); // time
    local.setUint16(12, 0x21, true); // date: 1980-01-01
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local, nameBytes, data);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(14, 0x21, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(42, offset, true);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dirSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length / 2, true);
  end.setUint16(10, central.length / 2, true);
  end.setUint32(12, dirSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export const xlsx = (sheets) => zip(workbookFiles(sheets));
