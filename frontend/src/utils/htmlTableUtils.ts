import DOMPurify from 'dompurify';

export type CellValueKind = 'empty' | 'null' | 'bool' | 'number' | 'text';

export interface TableColumnInfo {
  index: number;
  label: string;
  isIndex: boolean;
}

export interface TableMeta {
  visibleRows: number;
  dataCols: number;
  totalCols: number;
  shapeLabel: string;
  hasIndexColumn: boolean;
  canStickyIndex: boolean;
  canSort: boolean;
  canResizeColumns: boolean;
  canReorderColumns: boolean;
  columns: TableColumnInfo[];
  hasRowSpanInBody: boolean;
  hasDtypeRow: boolean;
  isTruncated: boolean;
  isVirtualized?: boolean;
  hasCustomStyles?: boolean;
}

export interface VirtualCellStyle {
  id?: string;
  className?: string;
  style?: string;
}

export interface VirtualTableRow {
  cells: string[];
  cellStyles?: (VirtualCellStyle | null)[];
  isEllipsis?: boolean;
  rowId?: string;
  rowClass?: string;
  rowStyle?: string;
  _searchCache?: string;
}

export interface VirtualTableData {
  theadHtml: string;
  headerTextRows: string[][];
  rows: VirtualTableRow[];
  colTypes: ('number' | 'text')[];
  ellipsisCols: boolean[];
  colEstimatedWidths: number[];
  hasCustomStyles: boolean;
  tableId?: string;
  tableClass?: string;
}

export interface VirtualExportSource {
  headerRows: string[][];
  rows: VirtualTableRow[];
  colOrder: number[];
  hiddenCols: Set<number>;
}

export type HtmlOutputBlock =
  | { type: 'html'; html: string }
  | { type: 'table'; tableHtml: string; meta: TableMeta; virtualData?: VirtualTableData };

export interface ParsedNotebookHtml {
  hasTables: boolean;
  sanitizedHtml: string;
  preservedStylesHtml: string;
  blocks: HtmlOutputBlock[];
}

export const VIRTUAL_TABLE_ROW_THRESHOLD = 100;

const MAX_PARSE_CACHE_ENTRIES = 16;
const htmlParseCache = new Map<string, ParsedNotebookHtml>();

const NULL_TOKENS = new Set([
  'nan',
  '<na>',
  'na',
  'n/a',
  'none',
  'null',
  'nat',
  '<null>',
]);

const BOOL_TOKENS = new Set(['true', 'false']);

const NUMBER_RE =
  /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?%?$|^[+-]?\.\d+(?:[eE][+-]?\d+)?%?$/;

const SPECIAL_NUM_TOKENS = new Set(['inf', '-inf', '+inf', 'infinity', '-infinity']);

const POLARS_DTYPE_RE =
  /^(str|utf8|f32|f64|i8|i16|i32|i64|i128|u8|u16|u32|u64|bool|date|time|null|cat|enum|binary|object|unknown|decimal\[.*\]|datetime\[.*\]|duration\[.*\]|list\[.*\]|array\[.*\]|struct\[.*\]|\.\.\.|…)$/i;

const POLARS_SHAPE_RE = /^shape:\s*\(\s*([^,)]+)\s*,\s*([^)]+)\s*\)$/i;
const PANDAS_SHAPE_RE = /^([\d,._\s]+)\s+rows?\s*[×x]\s*([\d,._\s]+)\s+columns?$/i;

function formatCountToken(raw: string): string {
  const cleaned = raw.replace(/[_,.\s]/g, '');
  if (/^\d+$/.test(cleaned)) {
    const num = Number(cleaned);
    if (Number.isSafeInteger(num)) return num.toLocaleString('pt-BR');
  }
  return raw.trim();
}

function parseShapeLabel(text: string): string | null {
  const trimmed = text.trim();
  const polarsMatch = trimmed.match(POLARS_SHAPE_RE);
  if (polarsMatch) {
    return `${formatCountToken(polarsMatch[1])} × ${formatCountToken(polarsMatch[2])}`;
  }
  const pandasMatch = trimmed.match(PANDAS_SHAPE_RE);
  if (pandasMatch) {
    return `${formatCountToken(pandasMatch[1])} × ${formatCountToken(pandasMatch[2])}`;
  }
  return null;
}

export function classifyCellValue(rawText: string): CellValueKind {
  const text = rawText.trim();
  if (!text) return 'empty';
  const lower = text.toLowerCase();
  if (NULL_TOKENS.has(lower)) return 'null';
  if (BOOL_TOKENS.has(lower)) return 'bool';
  if (SPECIAL_NUM_TOKENS.has(lower) || NUMBER_RE.test(text)) return 'number';
  return 'text';
}

export function isEllipsisToken(text: string): boolean {
  const t = text.trim();
  return t === '...' || t === '…';
}

function stripGenericDataframeCss(cssText: string): string {
  // Drop generic Pandas/Polars .dataframe layout blocks so they cannot leak globally
  // or override user wrap/alignment settings, while preserving any color/background paintings.
  const withoutDataframeRules = cssText.replace(
    /([^{}]*\.dataframe[^{}]*)\{([^}]*)\}/gi,
    (fullMatch, _selector: string, body: string) => {
      if (/(?:background|color|border-color|font-style|font-weight|text-decoration)\s*:/i.test(body)) {
        return fullMatch;
      }
      return '';
    }
  );
  return withoutDataframeRules.trim();
}

function isDataTableElement(table: HTMLTableElement): boolean {
  if (table.parentElement?.closest('table')) return false;
  if (table.getAttribute('role') === 'presentation') return false;
  if (table.getAttribute('aria-hidden') === 'true') return false;
  const firstRow = table.rows[0];
  if (!firstRow) return false;
  // Avoid hijacking tiny 1x1 layout tables unless marked as dataframe
  if (
    table.rows.length === 1 &&
    firstRow.children.length <= 1 &&
    !table.classList.contains('dataframe') &&
    !table.id.startsWith('T_')
  ) {
    return false;
  }
  return true;
}

function detectDtypeRow(thead: HTMLTableSectionElement | null): HTMLTableRowElement | null {
  if (!thead || thead.rows.length < 2) return null;
  const candidate = thead.rows[1];
  const cells = Array.from(candidate.cells);
  if (cells.length === 0) return null;
  // Polars dtype row uses <td> cells rather than <th>
  if (cells.some((c) => c.tagName !== 'TD')) return null;
  const nonEmpty = cells.map((c) => (c.textContent || '').trim()).filter(Boolean);
  if (nonEmpty.length === 0) return null;
  if (nonEmpty.every((t) => POLARS_DTYPE_RE.test(t))) {
    return candidate;
  }
  return null;
}

function compactPandasNamedIndexHeader(
  thead: HTMLTableSectionElement | null,
  dtypeRow: HTMLTableRowElement | null
): void {
  if (!thead) return;
  const headerRows = Array.from(thead.rows).filter((r) => r !== dtypeRow);
  if (headerRows.length !== 2) return;
  const [row0, row1] = headerRows;
  if (row0.cells.length < 2 || row0.cells.length !== row1.cells.length) return;
  const hasSpan = [...Array.from(row0.cells), ...Array.from(row1.cells)].some(
    (c) => c.colSpan > 1 || c.rowSpan > 1
  );
  if (hasSpan) return;

  const r0First = (row0.cells[0]?.textContent || '').trim();
  const r1First = (row1.cells[0]?.textContent || '').trim();
  const r1RestNonEmpty = Array.from(row1.cells)
    .slice(1)
    .some((c) => (c.textContent || '').trim() !== '');

  // Pandas named-index without columns.name creates a second header row containing
  // only the index name in cell 0 and empty cells for all data columns.
  if (!r0First && r1First && !r1RestNonEmpty) {
    row0.cells[0].textContent = r1First;
    row0.cells[0].setAttribute('title', r1First);
    const r1Style = row1.cells[0].getAttribute('style');
    if (r1Style && !row0.cells[0].getAttribute('style')) {
      row0.cells[0].setAttribute('style', r1Style);
    }
    row1.remove();
  }
}

function findPrimaryHeaderRow(
  thead: HTMLTableSectionElement | null,
  dtypeRow: HTMLTableRowElement | null
): HTMLTableRowElement | null {
  if (!thead) return null;
  const headerRows = Array.from(thead.rows).filter((r) => r !== dtypeRow);
  if (headerRows.length === 0) return null;
  if (headerRows.length === 1) return headerRows[0];

  const lastRow = headerRows[headerRows.length - 1];
  const lastCells = Array.from(lastRow.cells);
  const nonEmptyCount = lastCells.filter((c) => (c.textContent || '').trim() !== '').length;
  if (headerRows.length === 2 && lastCells.length > 1 && nonEmptyCount <= 1) {
    return headerRows[0];
  }
  return lastRow;
}

function stripBoilerplateTrAlign(tr: HTMLTableRowElement): void {
  const inlineAlign = tr.style.textAlign;
  if (inlineAlign && tr.style.length === 1) {
    tr.removeAttribute('style');
  } else if (inlineAlign) {
    tr.style.removeProperty('text-align');
  }
}

const HTML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeHtmlText(raw: string): string {
  let s = raw;
  if (s.indexOf('<') !== -1) {
    s = s.replace(/<[^>]*>/g, '');
  }
  if (s.indexOf('&') !== -1) {
    s = s.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|[a-zA-Z0-9]+);/g, (match, dec, hex) => {
      if (dec) {
        const code = Number(dec);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      if (hex) {
        const code = parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return HTML_ENTITIES[match.toLowerCase()] ?? match;
    });
  }
  return s.trim();
}

function sanitizeInlineStyleAttr(styleVal: string): string | undefined {
  const trimmed = styleVal.trim();
  if (!trimmed) return undefined;
  if (/url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:|-moz-binding/i.test(trimmed)) {
    return undefined;
  }
  // Ignore Pandas boilerplate text-align on <tr>
  if (/^text-align\s*:\s*(?:right|left|center)\s*;?$/i.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function extractSimpleAttrs(attrSlice: string): VirtualCellStyle | null {
  if (!attrSlice) return null;
  let id: string | undefined;
  let className: string | undefined;
  let style: string | undefined;

  const attrRe = /\b(id|class|style)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(attrSlice)) !== null) {
    const name = m[1].toLowerCase();
    const val = (m[2] ?? m[3] ?? '').trim();
    if (!val) continue;
    if (name === 'id') id = val;
    else if (name === 'class') className = val;
    else if (name === 'style') style = sanitizeInlineStyleAttr(val);
  }
  if (!id && !className && !style) return null;
  return {
    ...(id ? { id } : {}),
    ...(className ? { className } : {}),
    ...(style ? { style } : {}),
  };
}

interface ExtractedBodyStats {
  rows: VirtualTableRow[];
  expectedRowLen: number;
  maxCharsPerCol: Int32Array;
  canStickyIndex: boolean;
  indexPrefixCount: number;
  hasEllipsisRow: boolean;
  dataRowCount: number;
  hasInlineStyler: boolean;
}

/**
 * Zero-DOM SIMD indexOf parser for large uniform <tbody> strings (e.g. pd.set_option("display.max_rows", None)).
 * Parses 50,000+ rows in ~25-50ms without allocating hundreds of thousands of DOM nodes.
 */
function parseFastUniformTbody(tbodyInner: string): ExtractedBodyStats | null {
  // Normalize uppercase tags only if uppercase <TR / <TD / <TH exists
  const scanSource =
    tbodyInner.indexOf('<TR') !== -1 || tbodyInner.indexOf('<TD') !== -1 || tbodyInner.indexOf('<TH') !== -1
      ? tbodyInner.replace(/<\/?(?:TR|TD|TH)\b/g, (m) => m.toLowerCase())
      : tbodyInner;

  const rows: VirtualTableRow[] = [];
  let expectedRowLen = -1;
  let maxCharsPerCol = new Int32Array(0);
  let canStickyIndex = true;
  let indexPrefixCount = 0;
  let hasEllipsisRow = false;
  let dataRowCount = 0;
  let hasInlineStyler = false;

  let pos = 0;
  const len = scanSource.length;

  while (pos < len) {
    const trStart = scanSource.indexOf('<tr', pos);
    if (trStart === -1) break;
    const afterTr = scanSource.charCodeAt(trStart + 3);
    // Must be '>' (62) or whitespace (<= 32)
    if (afterTr !== 62 && afterTr > 32) {
      pos = trStart + 3;
      continue;
    }
    const trTagEnd = afterTr === 62 ? trStart + 3 : scanSource.indexOf('>', trStart + 3);
    if (trTagEnd === -1) return null;
    const trClose = scanSource.indexOf('</tr', trTagEnd + 1);
    if (trClose === -1) return null;

    const trAttrs =
      trTagEnd > trStart + 3 ? extractSimpleAttrs(tbodyInner.slice(trStart + 3, trTagEnd)) : null;

    const rowTexts: string[] = expectedRowLen > 0 ? new Array<string>(expectedRowLen) : [];
    let rowStyles: (VirtualCellStyle | null)[] | undefined;
    let colIdx = 0;
    let rowThCount = 0;
    let firstCellIsTh = false;
    let nonEmptyCount = 0;
    let allEllipsisInRow = true;

    let cPos = trTagEnd + 1;
    while (cPos < trClose) {
      const cellStart = scanSource.indexOf('<t', cPos);
      if (cellStart === -1 || cellStart >= trClose) break;
      const tagChar = scanSource.charCodeAt(cellStart + 2);
      // 'd' = 100, 'h' = 104
      if (tagChar !== 100 && tagChar !== 104) {
        cPos = cellStart + 2;
        continue;
      }
      const afterTag = scanSource.charCodeAt(cellStart + 3);
      if (afterTag !== 62 && afterTag > 32) {
        cPos = cellStart + 3;
        continue;
      }
      const cellTagEnd = afterTag === 62 ? cellStart + 3 : scanSource.indexOf('>', cellStart + 3);
      if (cellTagEnd === -1 || cellTagEnd >= trClose) return null;
      const cellClose = scanSource.indexOf('</t', cellTagEnd + 1);
      if (cellClose === -1 || cellClose > trClose) return null;

      const isTh = tagChar === 104;
      if (isTh) {
        rowThCount++;
        if (colIdx === 0) firstCellIsTh = true;
      }

      const rawInner = tbodyInner.slice(cellTagEnd + 1, cellClose);
      const txt =
        rawInner.indexOf('<') === -1 && rawInner.indexOf('&') === -1
          ? rawInner.trim()
          : decodeHtmlText(rawInner);

      if (expectedRowLen === -1) {
        rowTexts.push(txt);
      } else {
        if (colIdx >= expectedRowLen) return null; // Uneven columns -> fallback
        rowTexts[colIdx] = txt;
      }

      if (cellTagEnd > cellStart + 3) {
        const cAttrs = extractSimpleAttrs(tbodyInner.slice(cellStart + 3, cellTagEnd));
        if (cAttrs) {
          if (!rowStyles) {
            rowStyles =
              expectedRowLen > 0
                ? new Array<VirtualCellStyle | null>(expectedRowLen).fill(null)
                : [];
          }
          rowStyles[colIdx] = cAttrs;
          if (cAttrs.style && /background|color/i.test(cAttrs.style)) {
            hasInlineStyler = true;
          }
        }
      }

      if (txt.length > 0) {
        nonEmptyCount++;
        if (expectedRowLen > 0 && txt.length > maxCharsPerCol[colIdx]) {
          maxCharsPerCol[colIdx] = Math.min(80, txt.length);
        }
        if (allEllipsisInRow && !isEllipsisToken(txt)) {
          allEllipsisInRow = false;
        }
      }

      colIdx++;
      const closeEnd = scanSource.indexOf('>', cellClose + 3);
      cPos = closeEnd === -1 ? trClose : closeEnd + 1;
    }

    if (expectedRowLen === -1) {
      if (colIdx === 0) return null;
      expectedRowLen = colIdx;
      maxCharsPerCol = new Int32Array(expectedRowLen);
      for (let i = 0; i < expectedRowLen; i++) {
        maxCharsPerCol[i] = Math.min(80, rowTexts[i].length);
      }
      if (rowStyles && rowStyles.length < expectedRowLen) {
        const padded = new Array<VirtualCellStyle | null>(expectedRowLen).fill(null);
        for (let i = 0; i < rowStyles.length; i++) padded[i] = rowStyles[i] ?? null;
        rowStyles = padded;
      }
    } else if (colIdx !== expectedRowLen) {
      return null; // Irregular row -> fallback
    }

    if (rowThCount > indexPrefixCount) {
      indexPrefixCount = rowThCount;
    }
    if (!firstCellIsTh || rowThCount !== 1 || expectedRowLen < 2) {
      canStickyIndex = false;
    }

    const isEllipsis = nonEmptyCount > 0 && allEllipsisInRow;
    if (isEllipsis) {
      hasEllipsisRow = true;
    } else {
      dataRowCount++;
    }

    if (trAttrs?.style && /background|color/i.test(trAttrs.style)) {
      hasInlineStyler = true;
    }

    rows.push({
      cells: rowTexts,
      ...(rowStyles ? { cellStyles: rowStyles } : {}),
      ...(isEllipsis ? { isEllipsis: true } : {}),
      ...(trAttrs?.id ? { rowId: trAttrs.id } : {}),
      ...(trAttrs?.className ? { rowClass: trAttrs.className } : {}),
      ...(trAttrs?.style ? { rowStyle: trAttrs.style } : {}),
    });

    const trCloseEnd = scanSource.indexOf('>', trClose + 4);
    pos = trCloseEnd === -1 ? len : trCloseEnd + 1;
  }

  if (rows.length <= VIRTUAL_TABLE_ROW_THRESHOLD || expectedRowLen <= 0) {
    return null;
  }

  return {
    rows,
    expectedRowLen,
    maxCharsPerCol,
    canStickyIndex,
    indexPrefixCount,
    hasEllipsisRow,
    dataRowCount,
    hasInlineStyler,
  };
}

function finalizeVirtualTableFromStats(
  table: HTMLTableElement,
  stats: ExtractedBodyStats,
  externalShapeLabel: string | null,
  hasPreservedStyles: boolean
): { meta: TableMeta; virtualData: VirtualTableData } | null {
  const {
    rows: extractedRows,
    expectedRowLen,
    maxCharsPerCol,
    indexPrefixCount,
    hasEllipsisRow,
    dataRowCount,
    hasInlineStyler,
  } = stats;
  let { canStickyIndex } = stats;
  const rowCount = extractedRows.length;

  const thead = table.tHead;
  const dtypeRow = detectDtypeRow(thead);
  if (dtypeRow) {
    dtypeRow.setAttribute('data-sat-dtype-row', 'true');
  }
  compactPandasNamedIndexHeader(thead, dtypeRow);
  const primaryHeaderRow = findPrimaryHeaderRow(thead, dtypeRow);

  if (dtypeRow && dtypeRow.cells.length !== expectedRowLen) return null;
  if (primaryHeaderRow && primaryHeaderRow.cells.length !== expectedRowLen) return null;

  const headerRowsNonDtype = thead
    ? Array.from(thead.rows).filter((r) => r !== dtypeRow)
    : [];
  const headerHasMultiSpan = headerRowsNonDtype.some((r) =>
    Array.from(r.cells).some((c) => c.colSpan > 1 || c.rowSpan > 1)
  );

  if (canStickyIndex && thead) {
    for (const tr of Array.from(thead.rows)) {
      const firstCell = tr.cells[0];
      if (!firstCell || firstCell.rowSpan > 1 || firstCell.colSpan > 1) {
        canStickyIndex = false;
        break;
      }
    }
  }

  const canSort =
    Boolean(primaryHeaderRow) &&
    !headerHasMultiSpan &&
    !hasEllipsisRow &&
    dataRowCount > 1;

  const canReorderColumns =
    Boolean(primaryHeaderRow) &&
    !headerHasMultiSpan &&
    expectedRowLen > 1;

  const canResizeColumns = Boolean(primaryHeaderRow) && expectedRowLen > 0;

  const sampleIndices: number[] = [];
  const maxSamples = 240;
  if (rowCount <= maxSamples) {
    for (let i = 0; i < rowCount; i++) sampleIndices.push(i);
  } else {
    const step = (rowCount - 1) / (maxSamples - 1);
    for (let i = 0; i < maxSamples; i++) {
      sampleIndices.push(Math.round(i * step));
    }
  }

  const colTypes = new Array<'number' | 'text'>(expectedRowLen).fill('text');
  const ellipsisCols = new Array<boolean>(expectedRowLen).fill(false);
  const colEstimatedWidths = new Array<number>(expectedRowLen);
  const columns: TableColumnInfo[] = [];

  if (thead) {
    for (const tr of Array.from(thead.rows)) {
      stripBoilerplateTrAlign(tr);
      if (canStickyIndex && tr.cells[0]) {
        tr.cells[0].setAttribute('data-sat-sticky-index', 'true');
      }
      if (tr.cells.length === expectedRowLen) {
        for (let col = 0; col < expectedRowLen; col++) {
          tr.cells[col]?.setAttribute('data-sat-orig-col', String(col));
        }
      }
      for (const cell of Array.from(tr.cells)) {
        const txt = (cell.textContent || '').trim();
        if (txt && !cell.getAttribute('title')) {
          cell.setAttribute('title', txt);
        }
      }
    }
  }

  for (let col = 0; col < expectedRowLen; col++) {
    const isIndex = col === 0 && canStickyIndex;
    let hasNumber = false;
    let hasNonNumberText = false;
    let allEllipsisCol = sampleIndices.length > 0;

    if (!isIndex) {
      for (let s = 0; s < sampleIndices.length; s++) {
        const row = extractedRows[sampleIndices[s]];
        if (row.isEllipsis) continue;
        const txt = row.cells[col];
        if (!isEllipsisToken(txt)) {
          allEllipsisCol = false;
        }
        const kind = classifyCellValue(txt);
        if (kind === 'number') {
          hasNumber = true;
        } else if (kind === 'text' || kind === 'bool') {
          hasNonNumberText = true;
          if (hasNumber) break;
        }
      }
    } else {
      allEllipsisCol = false;
    }

    const colType: 'number' | 'text' = !isIndex && hasNumber && !hasNonNumberText ? 'number' : 'text';
    colTypes[col] = colType;
    ellipsisCols[col] = allEllipsisCol;

    const rawLabel = (primaryHeaderRow?.cells[col]?.textContent || '').trim();
    const label = rawLabel || (isIndex ? 'Índice' : `Coluna ${col + 1}`);
    columns.push({ index: col, label, isIndex });

    const headerChars = Math.min(48, rawLabel.length + (canSort ? 2 : 0));
    const maxChars = Math.max(headerChars, maxCharsPerCol[col]);
    const minColW = isIndex ? 54 : 68;
    colEstimatedWidths[col] = Math.round(Math.max(minColW, Math.min(420, maxChars * 8.0 + 26)));

    if (primaryHeaderRow && primaryHeaderRow.cells[col]) {
      const hCell = primaryHeaderRow.cells[col];
      hCell.setAttribute('data-sat-col-type', colType);
      hCell.setAttribute('data-sat-resizable-col', String(col));
      if (allEllipsisCol) {
        hCell.setAttribute('data-sat-ellipsis-col', 'true');
      } else if (canSort) {
        hCell.setAttribute('data-sat-sortable-col', String(col));
      }
    }
    if (dtypeRow && dtypeRow.cells[col]) {
      dtypeRow.cells[col].setAttribute('data-sat-col-type', colType);
    }
  }

  if (canStickyIndex && primaryHeaderRow?.cells[0]) {
    primaryHeaderRow.cells[0].setAttribute('data-sat-index-cell', 'true');
  }

  const headerTextRows: string[][] = [];
  if (thead) {
    for (const tr of Array.from(thead.rows)) {
      if (tr.getAttribute('data-sat-dtype-row') === 'true') continue;
      headerTextRows.push(Array.from(tr.cells).map((c) => (c.textContent || '').trim()));
    }
  }

  const totalCols = expectedRowLen;
  const dataCols = Math.max(
    1,
    totalCols - (canStickyIndex ? 1 : indexPrefixCount > 0 && totalCols > indexPrefixCount ? indexPrefixCount : 0)
  );
  const visibleRows = dataRowCount;
  const defaultShape = `${visibleRows.toLocaleString('pt-BR')} × ${dataCols.toLocaleString('pt-BR')}`;
  const hasCustomStyles = hasPreservedStyles || hasInlineStyler;

  table.classList.add('sat-table');

  return {
    meta: {
      visibleRows,
      dataCols,
      totalCols,
      shapeLabel: externalShapeLabel || defaultShape,
      hasIndexColumn: indexPrefixCount > 0,
      canStickyIndex,
      canSort,
      canResizeColumns,
      canReorderColumns,
      columns,
      hasRowSpanInBody: false,
      hasDtypeRow: Boolean(dtypeRow),
      isTruncated: hasEllipsisRow || Boolean(externalShapeLabel && externalShapeLabel !== defaultShape),
      isVirtualized: true,
      hasCustomStyles,
    },
    virtualData: {
      theadHtml: thead ? thead.outerHTML : '',
      headerTextRows,
      rows: extractedRows,
      colTypes,
      ellipsisCols,
      colEstimatedWidths,
      hasCustomStyles,
      tableId: table.id || undefined,
      tableClass: table.className,
    },
  };
}

/**
 * Fast single-pass extraction for large uniform tables (> VIRTUAL_TABLE_ROW_THRESHOLD rows).
 * Avoids mutating hundreds of thousands of DOM nodes or serializing multi-megabyte outerHTML.
 */
function tryExtractVirtualTable(
  table: HTMLTableElement,
  externalShapeLabel: string | null,
  hasPreservedStyles: boolean
): { meta: TableMeta; virtualData: VirtualTableData } | null {
  const tbodies = table.tBodies;
  if (tbodies.length !== 1) return null;
  const tbody = tbodies[0];
  const rowCount = tbody.rows.length;
  if (rowCount <= VIRTUAL_TABLE_ROW_THRESHOLD) return null;

  const thead = table.tHead;
  const dtypeRow = detectDtypeRow(thead);
  if (dtypeRow) {
    dtypeRow.setAttribute('data-sat-dtype-row', 'true');
  }
  compactPandasNamedIndexHeader(thead, dtypeRow);
  const primaryHeaderRow = findPrimaryHeaderRow(thead, dtypeRow);

  const firstBodyRow = tbody.rows[0];
  const expectedRowLen = firstBodyRow ? firstBodyRow.cells.length : 0;
  if (expectedRowLen === 0) return null;
  if (dtypeRow && dtypeRow.cells.length !== expectedRowLen) return null;
  if (primaryHeaderRow && primaryHeaderRow.cells.length !== expectedRowLen) return null;

  const headerRowsNonDtype = thead
    ? Array.from(thead.rows).filter((r) => r !== dtypeRow)
    : [];
  const headerHasMultiSpan = headerRowsNonDtype.some((r) =>
    Array.from(r.cells).some((c) => c.colSpan > 1 || c.rowSpan > 1)
  );

  // Single pass over tbody.rows: validate uniform grid & extract compact JS row model
  const extractedRows: VirtualTableRow[] = new Array(rowCount);
  const maxCharsPerCol = new Int32Array(expectedRowLen);
  let canStickyIndex = true;
  let indexPrefixCount = 0;
  let hasEllipsisRow = false;
  let dataRowCount = 0;
  let hasInlineStyler = false;

  const bodyRowsCollection = tbody.rows;
  for (let r = 0; r < rowCount; r++) {
    const tr = bodyRowsCollection[r];
    const cellsCol = tr.cells;
    if (cellsCol.length !== expectedRowLen) {
      return null; // Irregular row -> fall back to DOM mode
    }

    const rowTexts = new Array<string>(expectedRowLen);
    let rowStyles: (VirtualCellStyle | null)[] | undefined;
    let rowThCount = 0;
    let nonEmptyCount = 0;
    let allEllipsisInRow = true;

    for (let c = 0; c < expectedRowLen; c++) {
      const cell = cellsCol[c];
      if (cell.rowSpan > 1 || cell.colSpan > 1) {
        return null; // Merged body cells -> fall back to DOM mode
      }
      if (cell.tagName === 'TH') {
        rowThCount++;
      }
      const rawTxt = cell.textContent || '';
      const trimmed = rawTxt.trim();
      rowTexts[c] = trimmed;

      if (trimmed.length > 0) {
        nonEmptyCount++;
        if (trimmed.length > maxCharsPerCol[c]) {
          maxCharsPerCol[c] = Math.min(80, trimmed.length);
        }
        if (allEllipsisInRow && !isEllipsisToken(trimmed)) {
          allEllipsisInRow = false;
        }
      }

      const cid = cell.id;
      const ccls = cell.className;
      const cstyle = cell.getAttribute('style');
      if (cid || ccls || cstyle) {
        if (!rowStyles) {
          rowStyles = new Array<VirtualCellStyle | null>(expectedRowLen).fill(null);
        }
        rowStyles[c] = {
          ...(cid ? { id: cid } : {}),
          ...(ccls ? { className: ccls } : {}),
          ...(cstyle ? { style: cstyle } : {}),
        };
        if (cstyle && /background|color/i.test(cstyle)) {
          hasInlineStyler = true;
        }
      }
    }

    if (rowThCount > indexPrefixCount) {
      indexPrefixCount = rowThCount;
    }
    if (
      cellsCol[0].tagName !== 'TH' ||
      rowThCount !== 1 ||
      expectedRowLen < 2
    ) {
      canStickyIndex = false;
    }

    const isEllipsis = nonEmptyCount > 0 && allEllipsisInRow;
    if (isEllipsis) {
      hasEllipsisRow = true;
    } else {
      dataRowCount++;
    }

    stripBoilerplateTrAlign(tr);
    const trStyle = tr.getAttribute('style') || undefined;
    const trId = tr.id || undefined;
    const trClass = tr.className || undefined;
    if (trStyle && /background|color/i.test(trStyle)) {
      hasInlineStyler = true;
    }

    extractedRows[r] = {
      cells: rowTexts,
      ...(rowStyles ? { cellStyles: rowStyles } : {}),
      ...(isEllipsis ? { isEllipsis: true } : {}),
      ...(trId ? { rowId: trId } : {}),
      ...(trClass ? { rowClass: trClass } : {}),
      ...(trStyle ? { rowStyle: trStyle } : {}),
    };
  }

  if (canStickyIndex && thead) {
    for (const tr of Array.from(thead.rows)) {
      const firstCell = tr.cells[0];
      if (!firstCell || firstCell.rowSpan > 1 || firstCell.colSpan > 1) {
        canStickyIndex = false;
        break;
      }
    }
  }

  const canSort =
    Boolean(primaryHeaderRow) &&
    !headerHasMultiSpan &&
    !hasEllipsisRow &&
    dataRowCount > 1;

  const canReorderColumns =
    Boolean(primaryHeaderRow) &&
    !headerHasMultiSpan &&
    expectedRowLen > 1;

  const canResizeColumns = Boolean(primaryHeaderRow) && expectedRowLen > 0;

  // Sample up to 240 rows evenly across the table to infer column types in < 0.2ms
  const sampleIndices: number[] = [];
  const maxSamples = 240;
  if (rowCount <= maxSamples) {
    for (let i = 0; i < rowCount; i++) sampleIndices.push(i);
  } else {
    const step = (rowCount - 1) / (maxSamples - 1);
    for (let i = 0; i < maxSamples; i++) {
      sampleIndices.push(Math.round(i * step));
    }
  }

  const colTypes = new Array<'number' | 'text'>(expectedRowLen).fill('text');
  const ellipsisCols = new Array<boolean>(expectedRowLen).fill(false);
  const colEstimatedWidths = new Array<number>(expectedRowLen);
  const columns: TableColumnInfo[] = [];

  if (thead) {
    for (const tr of Array.from(thead.rows)) {
      stripBoilerplateTrAlign(tr);
      if (canStickyIndex && tr.cells[0]) {
        tr.cells[0].setAttribute('data-sat-sticky-index', 'true');
      }
      if (tr.cells.length === expectedRowLen) {
        for (let col = 0; col < expectedRowLen; col++) {
          tr.cells[col]?.setAttribute('data-sat-orig-col', String(col));
        }
      }
      for (const cell of Array.from(tr.cells)) {
        const txt = (cell.textContent || '').trim();
        if (txt && !cell.getAttribute('title')) {
          cell.setAttribute('title', txt);
        }
      }
    }
  }

  for (let col = 0; col < expectedRowLen; col++) {
    const isIndex = col === 0 && canStickyIndex;
    let hasNumber = false;
    let hasNonNumberText = false;
    let allEllipsisCol = sampleIndices.length > 0;

    if (!isIndex) {
      for (let s = 0; s < sampleIndices.length; s++) {
        const row = extractedRows[sampleIndices[s]];
        if (row.isEllipsis) continue;
        const txt = row.cells[col];
        if (!isEllipsisToken(txt)) {
          allEllipsisCol = false;
        }
        const kind = classifyCellValue(txt);
        if (kind === 'number') {
          hasNumber = true;
        } else if (kind === 'text' || kind === 'bool') {
          hasNonNumberText = true;
          if (hasNumber) break; // Mixed column -> definitely text
        }
      }
    } else {
      allEllipsisCol = false;
    }

    const colType: 'number' | 'text' = !isIndex && hasNumber && !hasNonNumberText ? 'number' : 'text';
    colTypes[col] = colType;
    ellipsisCols[col] = allEllipsisCol;

    const rawLabel = (primaryHeaderRow?.cells[col]?.textContent || '').trim();
    const label = rawLabel || (isIndex ? 'Índice' : `Coluna ${col + 1}`);
    columns.push({ index: col, label, isIndex });

    // Estimate stable column width from header + widest cell across all rows
    const headerChars = Math.min(48, rawLabel.length + (canSort ? 2 : 0));
    const maxChars = Math.max(headerChars, maxCharsPerCol[col]);
    const minColW = isIndex ? 54 : 68;
    colEstimatedWidths[col] = Math.round(Math.max(minColW, Math.min(420, maxChars * 8.0 + 26)));

    if (primaryHeaderRow && primaryHeaderRow.cells[col]) {
      const hCell = primaryHeaderRow.cells[col];
      hCell.setAttribute('data-sat-col-type', colType);
      hCell.setAttribute('data-sat-resizable-col', String(col));
      if (allEllipsisCol) {
        hCell.setAttribute('data-sat-ellipsis-col', 'true');
      } else if (canSort) {
        hCell.setAttribute('data-sat-sortable-col', String(col));
      }
    }
    if (dtypeRow && dtypeRow.cells[col]) {
      dtypeRow.cells[col].setAttribute('data-sat-col-type', colType);
    }
  }

  if (canStickyIndex && primaryHeaderRow?.cells[0]) {
    primaryHeaderRow.cells[0].setAttribute('data-sat-index-cell', 'true');
  }

  const headerTextRows: string[][] = [];
  if (thead) {
    for (const tr of Array.from(thead.rows)) {
      if (tr.getAttribute('data-sat-dtype-row') === 'true') continue;
      headerTextRows.push(Array.from(tr.cells).map((c) => (c.textContent || '').trim()));
    }
  }

  const totalCols = expectedRowLen;
  const dataCols = Math.max(
    1,
    totalCols - (canStickyIndex ? 1 : indexPrefixCount > 0 && totalCols > indexPrefixCount ? indexPrefixCount : 0)
  );
  const visibleRows = dataRowCount;
  const defaultShape = `${visibleRows.toLocaleString('pt-BR')} × ${dataCols.toLocaleString('pt-BR')}`;
  const hasCustomStyles = hasPreservedStyles || hasInlineStyler;

  table.classList.add('sat-table');

  return {
    meta: {
      visibleRows,
      dataCols,
      totalCols,
      shapeLabel: externalShapeLabel || defaultShape,
      hasIndexColumn: indexPrefixCount > 0,
      canStickyIndex,
      canSort,
      canResizeColumns,
      canReorderColumns,
      columns,
      hasRowSpanInBody: false,
      hasDtypeRow: Boolean(dtypeRow),
      isTruncated: hasEllipsisRow || Boolean(externalShapeLabel && externalShapeLabel !== defaultShape),
      isVirtualized: true,
      hasCustomStyles,
    },
    virtualData: {
      theadHtml: thead ? thead.outerHTML : '',
      headerTextRows,
      rows: extractedRows,
      colTypes,
      ellipsisCols,
      colEstimatedWidths,
      hasCustomStyles,
      tableId: table.id || undefined,
      tableClass: table.className,
    },
  };
}

function enhanceTableElement(
  table: HTMLTableElement,
  externalShapeLabel: string | null,
  hasPreservedStyles: boolean
): TableMeta {
  table.classList.add('sat-table');
  table.removeAttribute('border');

  const thead = table.tHead;
  const tbodies = Array.from(table.tBodies);
  const tbody = tbodies[0] || null;

  const dtypeRow = detectDtypeRow(thead);
  if (dtypeRow) {
    dtypeRow.setAttribute('data-sat-dtype-row', 'true');
  }

  compactPandasNamedIndexHeader(thead, dtypeRow);
  const primaryHeaderRow = findPrimaryHeaderRow(thead, dtypeRow);

  if (thead) {
    for (const tr of Array.from(thead.rows)) {
      stripBoilerplateTrAlign(tr);
      for (const cell of Array.from(tr.cells)) {
        const txt = (cell.textContent || '').trim();
        if (txt && !cell.getAttribute('title')) {
          cell.setAttribute('title', txt);
        }
      }
    }
  }

  const bodyRows = tbody ? Array.from(tbody.rows) : [];
  let hasRowSpanInBody = false;
  let hasColSpanInBody = false;
  let hasEllipsisRow = false;
  let hasInlineStyler = false;
  let dataRowCount = 0;

  let indexPrefixCount = 0;
  let canStickyIndex = bodyRows.length > 0;

  for (const tr of bodyRows) {
    stripBoilerplateTrAlign(tr);
    const trStyle = tr.getAttribute('style');
    if (trStyle && /background|color/i.test(trStyle)) {
      hasInlineStyler = true;
    }
    const cells = Array.from(tr.cells);
    const rowThs = cells.filter((c) => c.tagName === 'TH');
    const rowTds = cells.filter((c) => c.tagName === 'TD');

    if (rowThs.length > 0) {
      indexPrefixCount = Math.max(indexPrefixCount, rowThs.length);
    }

    if (
      cells.length === 0 ||
      cells[0].tagName !== 'TH' ||
      rowThs.length !== 1 ||
      rowTds.length === 0 ||
      cells[0].rowSpan > 1 ||
      cells[0].colSpan > 1
    ) {
      canStickyIndex = false;
    }

    for (const cell of cells) {
      if (cell.rowSpan > 1) hasRowSpanInBody = true;
      if (cell.colSpan > 1) hasColSpanInBody = true;

      const cStyle = cell.getAttribute('style');
      if (cStyle && /background|color/i.test(cStyle)) {
        hasInlineStyler = true;
      }

      const txt = (cell.textContent || '').trim();
      if (txt && !cell.getAttribute('title') && bodyRows.length <= 300) {
        cell.setAttribute('title', txt);
      }
    }

    const nonEmptyCells = cells.map((c) => (c.textContent || '').trim()).filter(Boolean);
    const isEllipsisRow =
      nonEmptyCells.length > 0 && nonEmptyCells.every((t) => isEllipsisToken(t));
    if (isEllipsisRow) {
      tr.setAttribute('data-sat-ellipsis-row', 'true');
      hasEllipsisRow = true;
    } else {
      dataRowCount += 1;
    }
  }

  if (canStickyIndex && thead) {
    for (const tr of Array.from(thead.rows)) {
      const firstCell = tr.cells[0];
      if (!firstCell || firstCell.rowSpan > 1 || firstCell.colSpan > 1) {
        canStickyIndex = false;
        break;
      }
    }
  }
  if (tbodies.length > 1) {
    canStickyIndex = false;
  }

  if (canStickyIndex) {
    if (thead) {
      for (const tr of Array.from(thead.rows)) {
        tr.cells[0]?.setAttribute('data-sat-sticky-index', 'true');
      }
    }
    for (const tr of bodyRows) {
      tr.cells[0]?.setAttribute('data-sat-sticky-index', 'true');
    }
  }

  const headerRowsNonDtype = thead
    ? Array.from(thead.rows).filter((r) => r !== dtypeRow)
    : [];
  const headerHasMultiSpan = headerRowsNonDtype.some((r) =>
    Array.from(r.cells).some((c) => c.colSpan > 1 || c.rowSpan > 1)
  );

  const expectedRowLen = primaryHeaderRow ? primaryHeaderRow.cells.length : bodyRows[0]?.cells.length || 0;
  const isUniformGrid =
    expectedRowLen > 0 &&
    !hasRowSpanInBody &&
    !hasColSpanInBody &&
    tbodies.length <= 1 &&
    bodyRows.every((r) => r.cells.length === expectedRowLen) &&
    (!dtypeRow || dtypeRow.cells.length === expectedRowLen) &&
    (!primaryHeaderRow || primaryHeaderRow.cells.length === expectedRowLen);

  for (const tb of tbodies) {
    for (const tr of Array.from(tb.rows)) {
      const isEllipsis = tr.getAttribute('data-sat-ellipsis-row') === 'true';
      for (const cell of Array.from(tr.cells)) {
        if (cell.tagName === 'TH') {
          cell.setAttribute('data-sat-index-cell', 'true');
        }
        const txt = cell.textContent || '';
        if (isEllipsis || isEllipsisToken(txt)) {
          cell.setAttribute('data-sat-type', 'null');
        } else {
          const kind = classifyCellValue(txt);
          cell.setAttribute('data-sat-type', kind);
        }
      }
    }
  }

  const canSort =
    isUniformGrid &&
    Boolean(primaryHeaderRow) &&
    !headerHasMultiSpan &&
    !hasEllipsisRow &&
    dataRowCount > 1;

  const canReorderColumns =
    isUniformGrid &&
    Boolean(primaryHeaderRow) &&
    !headerHasMultiSpan &&
    expectedRowLen > 1;

  const canResizeColumns = Boolean(primaryHeaderRow) && expectedRowLen > 0;
  const columns: TableColumnInfo[] = [];

  if (isUniformGrid) {
    if (thead) {
      for (const tr of Array.from(thead.rows)) {
        if (tr.cells.length === expectedRowLen) {
          for (let col = 0; col < expectedRowLen; col++) {
            tr.cells[col]?.setAttribute('data-sat-orig-col', String(col));
          }
        }
      }
    }

    for (let col = 0; col < expectedRowLen; col++) {
      let hasNumber = false;
      let hasNonNumberText = false;
      let allEllipsisCol = bodyRows.length > 0;

      for (const tr of bodyRows) {
        const cell = tr.cells[col];
        if (cell) {
          cell.setAttribute('data-sat-orig-col', String(col));
        }
        if (tr.getAttribute('data-sat-ellipsis-row') === 'true') continue;
        if (!cell) continue;
        const txt = (cell.textContent || '').trim();
        if (!isEllipsisToken(txt)) {
          allEllipsisCol = false;
        }
        const kind = cell.getAttribute('data-sat-type') as CellValueKind | null;
        if (kind === 'number') {
          hasNumber = true;
        } else if (kind === 'text' || kind === 'bool') {
          hasNonNumberText = true;
        }
      }

      const colType: 'number' | 'text' = hasNumber && !hasNonNumberText ? 'number' : 'text';

      for (const tr of bodyRows) {
        const cell = tr.cells[col];
        if (!cell) continue;
        cell.setAttribute('data-sat-col-type', colType);
        if (allEllipsisCol) cell.setAttribute('data-sat-ellipsis-col', 'true');
      }

      if (primaryHeaderRow && primaryHeaderRow.cells[col]) {
        const hCell = primaryHeaderRow.cells[col];
        hCell.setAttribute('data-sat-col-type', colType);
        hCell.setAttribute('data-sat-resizable-col', String(col));
        if (allEllipsisCol) {
          hCell.setAttribute('data-sat-ellipsis-col', 'true');
        } else if (canSort) {
          hCell.setAttribute('data-sat-sortable-col', String(col));
        }
      }
      if (dtypeRow && dtypeRow.cells[col]) {
        dtypeRow.cells[col].setAttribute('data-sat-col-type', colType);
      }

      const isIndex = col === 0 && canStickyIndex;
      const rawLabel = (primaryHeaderRow?.cells[col]?.textContent || '').trim();
      columns.push({
        index: col,
        label: rawLabel || (isIndex ? 'Índice' : `Coluna ${col + 1}`),
        isIndex,
      });
    }

    if (canStickyIndex && primaryHeaderRow?.cells[0]) {
      primaryHeaderRow.cells[0].setAttribute('data-sat-index-cell', 'true');
    }
  } else {
    if (primaryHeaderRow) {
      for (let col = 0; col < primaryHeaderRow.cells.length; col++) {
        const hCell = primaryHeaderRow.cells[col];
        hCell.setAttribute('data-sat-orig-col', String(col));
        hCell.setAttribute('data-sat-resizable-col', String(col));
        const rawLabel = (hCell.textContent || '').trim();
        columns.push({
          index: col,
          label: rawLabel || `Coluna ${col + 1}`,
          isIndex: col === 0 && canStickyIndex,
        });
      }
    }
    for (const tb of tbodies) {
      for (const tr of Array.from(tb.rows)) {
        for (const cell of Array.from(tr.cells)) {
          if (cell.tagName === 'TD') {
            const kind = cell.getAttribute('data-sat-type');
            cell.setAttribute('data-sat-col-type', kind === 'number' ? 'number' : 'text');
          }
        }
      }
    }
  }

  const totalCols = expectedRowLen || (bodyRows[0]?.cells.length ?? 0);
  const dataCols = Math.max(
    1,
    totalCols - (canStickyIndex ? 1 : indexPrefixCount > 0 && totalCols > indexPrefixCount ? indexPrefixCount : 0)
  );
  const visibleRows = dataRowCount;
  const defaultShape = `${visibleRows.toLocaleString('pt-BR')} × ${dataCols.toLocaleString('pt-BR')}`;

  return {
    visibleRows,
    dataCols,
    totalCols,
    shapeLabel: externalShapeLabel || defaultShape,
    hasIndexColumn: indexPrefixCount > 0,
    canStickyIndex,
    canSort,
    canResizeColumns,
    canReorderColumns,
    columns,
    hasRowSpanInBody,
    hasDtypeRow: Boolean(dtypeRow),
    isTruncated: hasEllipsisRow || Boolean(externalShapeLabel && externalShapeLabel !== defaultShape),
    isVirtualized: false,
    hasCustomStyles: hasPreservedStyles || hasInlineStyler,
  };
}

function detachLargeUniformTbodies(rawHtml: string): {
  shellHtml: string;
  detached: Map<string, string>;
} {
  const detached = new Map<string, string>();
  if (rawHtml.length <= 50_000) {
    return { shellHtml: rawHtml, detached };
  }

  let out = '';
  let cursor = 0;
  let seq = 0;
  const lower = rawHtml.toLowerCase();

  while (cursor < rawHtml.length) {
    const tbOpen = lower.indexOf('<tbody', cursor);
    if (tbOpen === -1) {
      out += rawHtml.slice(cursor);
      break;
    }
    const tbOpenEnd = lower.indexOf('>', tbOpen + 6);
    if (tbOpenEnd === -1) {
      out += rawHtml.slice(cursor);
      break;
    }
    const tbClose = lower.indexOf('</tbody>', tbOpenEnd + 1);
    if (tbClose === -1) {
      out += rawHtml.slice(cursor);
      break;
    }

    const innerLen = tbClose - (tbOpenEnd + 1);
    if (innerLen > 20_000) {
      const innerLower = lower.slice(tbOpenEnd + 1, tbClose);
      if (
        innerLower.indexOf('<table') === -1 &&
        innerLower.indexOf('rowspan=') === -1 &&
        innerLower.indexOf('colspan=') === -1
      ) {
        const markerId = `__sat_fast_tbody_${seq++}__`;
        detached.set(markerId, rawHtml.slice(tbOpenEnd + 1, tbClose));
        out += rawHtml.slice(cursor, tbOpen);
        out += `<tbody id="${markerId}"><tr><th>0</th><td>0</td></tr></tbody>`;
        cursor = tbClose + 8;
        continue;
      }
    }

    out += rawHtml.slice(cursor, tbClose + 8);
    cursor = tbClose + 8;
  }

  return { shellHtml: out, detached };
}

export function inspectAndEnhanceHtml(rawHtml: string): ParsedNotebookHtml {
  const cached = htmlParseCache.get(rawHtml);
  if (cached) return cached;

  const remember = (res: ParsedNotebookHtml): ParsedNotebookHtml => {
    // Avoid keeping huge rawHtml keys forever; evict oldest when full
    if (htmlParseCache.size >= MAX_PARSE_CACHE_ENTRIES) {
      const oldestKey = htmlParseCache.keys().next().value;
      if (oldestKey !== undefined) htmlParseCache.delete(oldestKey);
    }
    htmlParseCache.set(rawHtml, res);
    return res;
  };

  if (!/<table[\s>]/i.test(rawHtml)) {
    const sanitizedHtml = DOMPurify.sanitize(rawHtml, {
      FORCE_BODY: true,
      ADD_TAGS: ['style'],
      ADD_ATTR: ['style', 'class', 'id', 'colspan', 'rowspan', 'scope'],
    });
    return remember({
      hasTables: false,
      sanitizedHtml,
      preservedStylesHtml: '',
      blocks: [{ type: 'html', html: sanitizedHtml }],
    });
  }

  // Detach giant uniform <tbody> blocks (>20 KB) before DOMPurify so DOMPurify only walks
  // the ~2 KB table shell (<style>, <thead>, surrounding tags) instead of 1,000,000+ <td> nodes!
  const { shellHtml, detached } = detachLargeUniformTbodies(rawHtml);

  const bodyEl = DOMPurify.sanitize(shellHtml, {
    RETURN_DOM: true,
    FORCE_BODY: true,
    ADD_TAGS: ['style'],
    ADD_ATTR: ['style', 'class', 'id', 'colspan', 'rowspan', 'scope'],
  }) as unknown as HTMLElement;

  const preservedStyles: string[] = [];
  for (const styleEl of Array.from(bodyEl.querySelectorAll('style'))) {
    const cleaned = stripGenericDataframeCss(styleEl.textContent || '');
    if (cleaned) {
      preservedStyles.push(`<style>${cleaned}</style>`);
    }
    styleEl.remove();
  }

  const allTables = Array.from(bodyEl.querySelectorAll('table')).filter(isDataTableElement);
  if (allTables.length === 0) {
    const fallbackHtml = bodyEl.innerHTML;
    return remember({
      hasTables: false,
      sanitizedHtml: fallbackHtml,
      preservedStylesHtml: '',
      blocks: [{ type: 'html', html: fallbackHtml }],
    });
  }

  const hasPreservedStyles = preservedStyles.length > 0;

  // Flatten transparent wrapper nodes so sibling <small>, <table>, <p> can be processed cleanly
  const flattenContainers = (container: Element): ChildNode[] => {
    const out: ChildNode[] = [];
    for (const child of Array.from(container.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as HTMLElement;
        if (
          (el.tagName === 'DIV' || el.tagName === 'SECTION') &&
          !el.getAttribute('style') &&
          el.querySelector('table')
        ) {
          out.push(...flattenContainers(el));
          continue;
        }
      }
      out.push(child);
    }
    return out;
  };

  const flatNodes = flattenContainers(bodyEl);
  const blocks: HtmlOutputBlock[] = [];
  let htmlBuffer: string[] = [];

  const flushHtmlBuffer = () => {
    const joined = htmlBuffer.join('').trim();
    if (joined) {
      blocks.push({ type: 'html', html: joined });
    }
    htmlBuffer = [];
  };

  for (let i = 0; i < flatNodes.length; i++) {
    const node = flatNodes[i];

    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.textContent || '').trim()) {
        htmlBuffer.push(node.textContent || '');
      }
      continue;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as HTMLElement;

    if (el.tagName === 'SMALL') {
      const nextEl = flatNodes.slice(i + 1).find((n) => {
        if (n.nodeType === Node.TEXT_NODE) return Boolean((n.textContent || '').trim());
        return n.nodeType === Node.ELEMENT_NODE;
      }) as HTMLElement | undefined;
      if (
        nextEl?.tagName === 'TABLE' &&
        isDataTableElement(nextEl as HTMLTableElement) &&
        parseShapeLabel(el.textContent || '')
      ) {
        continue;
      }
    }

    if (el.tagName === 'TABLE' && isDataTableElement(el as HTMLTableElement)) {
      flushHtmlBuffer();

      let externalShape: string | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const prev = flatNodes[j];
        if (prev.nodeType === Node.TEXT_NODE && !(prev.textContent || '').trim()) continue;
        if (prev.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === 'SMALL') {
          externalShape = parseShapeLabel(prev.textContent || '');
        }
        break;
      }

      for (let j = i + 1; j < flatNodes.length; j++) {
        const next = flatNodes[j];
        if (next.nodeType === Node.TEXT_NODE && !(next.textContent || '').trim()) continue;
        if (next.nodeType === Node.ELEMENT_NODE && (next as HTMLElement).tagName === 'P') {
          const parsedPandas = parseShapeLabel(next.textContent || '');
          if (parsedPandas) {
            if (!externalShape) externalShape = parsedPandas;
            i = j;
          }
        }
        break;
      }

      const tableEl = el as HTMLTableElement;
      const firstTbody = tableEl.tBodies[0];
      const detachedInner =
        tableEl.tBodies.length === 1 && firstTbody?.id ? detached.get(firstTbody.id) : undefined;

      if (detachedInner !== undefined && firstTbody) {
        firstTbody.removeAttribute('id');
        const fastStats = parseFastUniformTbody(detachedInner);
        const fastBuilt = fastStats
          ? finalizeVirtualTableFromStats(tableEl, fastStats, externalShape, hasPreservedStyles)
          : null;
        if (fastBuilt) {
          blocks.push({
            type: 'table',
            tableHtml: '',
            meta: fastBuilt.meta,
            virtualData: fastBuilt.virtualData,
          });
          continue;
        }
        // Fallback if irregular rows were inside detachedInner: sanitize & restore DOM tbody
        const sanitizedTbodyWrap = DOMPurify.sanitize(`<table><tbody>${detachedInner}</tbody></table>`, {
          RETURN_DOM: true,
          FORCE_BODY: true,
          ADD_ATTR: ['style', 'class', 'id', 'colspan', 'rowspan', 'scope'],
        }) as unknown as HTMLElement;
        const restoredTbody = sanitizedTbodyWrap.querySelector('tbody');
        if (restoredTbody) {
          firstTbody.replaceWith(restoredTbody);
        }
      }

      const virtualExtracted = tryExtractVirtualTable(
        tableEl,
        externalShape,
        hasPreservedStyles
      );
      if (virtualExtracted) {
        blocks.push({
          type: 'table',
          tableHtml: '',
          meta: virtualExtracted.meta,
          virtualData: virtualExtracted.virtualData,
        });
      } else {
        const meta = enhanceTableElement(
          el as HTMLTableElement,
          externalShape,
          hasPreservedStyles
        );
        blocks.push({
          type: 'table',
          tableHtml: el.outerHTML,
          meta,
        });
      }
      continue;
    }

    htmlBuffer.push(el.outerHTML);
  }

  flushHtmlBuffer();

  return remember({
    hasTables: blocks.some((b) => b.type === 'table'),
    sanitizedHtml: '',
    preservedStylesHtml: preservedStyles.join('\n'),
    blocks,
  });
}

function escapeCsvCell(val: string): string {
  if (/[",\n\r]/.test(val)) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function escapeMarkdownCell(val: string): string {
  return val.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatDelimitedOutput(
  headerRows: string[][],
  bodyRows: string[][],
  format: 'tsv' | 'csv' | 'markdown'
): string {
  if (format === 'tsv') {
    return [...headerRows, ...bodyRows]
      .map((row) => row.map((v) => v.replace(/[\t\r\n]+/g, ' ')).join('\t'))
      .join('\n');
  }

  if (format === 'csv') {
    return [...headerRows, ...bodyRows]
      .map((row) => row.map(escapeCsvCell).join(','))
      .join('\n');
  }

  const head = headerRows[headerRows.length - 1] || bodyRows[0] || [];
  const data = headerRows.length > 0 ? bodyRows : bodyRows.slice(1);
  if (head.length === 0) return '';
  const sep = head.map(() => '---');
  const lines = [
    `| ${head.map(escapeMarkdownCell).join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...data.map((row) => `| ${row.map(escapeMarkdownCell).join(' | ')} |`),
  ];
  return lines.join('\n');
}

export interface ExtractTableOptions {
  includeHiddenRows?: boolean;
  includeHiddenCols?: boolean;
  visibleRowSet?: Set<HTMLTableRowElement>;
  virtualSource?: VirtualExportSource;
}

export function extractTableDelimited(
  table: HTMLTableElement,
  format: 'tsv' | 'csv' | 'markdown',
  options?: ExtractTableOptions
): string {
  const includeHiddenRows = options?.includeHiddenRows ?? false;
  const includeHiddenCols = options?.includeHiddenCols ?? false;
  const virtualSource = options?.virtualSource;

  if (virtualSource) {
    const activeCols = includeHiddenCols
      ? virtualSource.colOrder
      : virtualSource.colOrder.filter((c) => !virtualSource.hiddenCols.has(c));

    const headerRows = virtualSource.headerRows.map((hRow) =>
      hRow.length === virtualSource.colOrder.length
        ? activeCols.map((c) => hRow[c] ?? '')
        : hRow
    );
    const bodyRows = virtualSource.rows.map((r) => activeCols.map((c) => r.cells[c] ?? ''));
    return formatDelimitedOutput(headerRows, bodyRows, format);
  }

  const headerRows: string[][] = [];
  const bodyRows: string[][] = [];
  const visibleRowSet = options?.visibleRowSet;

  const filterCells = (cells: HTMLCollectionOf<HTMLTableCellElement>) =>
    Array.from(cells)
      .filter((c) => includeHiddenCols || (!c.hidden && c.getAttribute('data-sat-col-hidden') !== 'true'))
      .map((c) => (c.textContent || '').trim());

  if (table.tHead) {
    for (const tr of Array.from(table.tHead.rows)) {
      if (tr.getAttribute('data-sat-dtype-row') === 'true') continue;
      headerRows.push(filterCells(tr.cells));
    }
  }

  for (const tb of Array.from(table.tBodies)) {
    for (const tr of Array.from(tb.rows)) {
      if (tr.getAttribute('data-sat-spacer') === 'true') continue;
      if (!includeHiddenRows && tr.hidden) continue;
      if (visibleRowSet && !visibleRowSet.has(tr)) continue;
      bodyRows.push(filterCells(tr.cells));
    }
  }

  return formatDelimitedOutput(headerRows, bodyRows, format);
}

const PT_BR_COLLATOR = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

export function compareTableCellValues(aRaw: string, bRaw: string): number {
  const a = aRaw.trim();
  const b = bRaw.trim();
  const aKind = classifyCellValue(a);
  const bKind = classifyCellValue(b);

  const aMissing = aKind === 'empty' || aKind === 'null';
  const bMissing = bKind === 'empty' || bKind === 'null';
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  if (aKind === 'number' && bKind === 'number') {
    const aNum = Number(a.indexOf(',') === -1 && !a.endsWith('%') ? a : a.replace(/,/g, '').replace(/%$/, ''));
    const bNum = Number(b.indexOf(',') === -1 && !b.endsWith('%') ? b : b.replace(/,/g, '').replace(/%$/, ''));
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
      return aNum - bNum;
    }
  }

  return PT_BR_COLLATOR.compare(a, b);
}
