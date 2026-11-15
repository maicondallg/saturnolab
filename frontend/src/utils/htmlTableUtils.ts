import DOMPurify from 'dompurify';

export type CellValueKind = 'empty' | 'null' | 'bool' | 'number' | 'text';

export interface TableMeta {
  visibleRows: number;
  dataCols: number;
  shapeLabel: string;
  hasIndexColumn: boolean;
  canStickyIndex: boolean;
  canSort: boolean;
  hasRowSpanInBody: boolean;
  hasDtypeRow: boolean;
  isTruncated: boolean;
}

export type HtmlOutputBlock =
  | { type: 'html'; html: string }
  | { type: 'table'; tableHtml: string; meta: TableMeta };

export interface ParsedNotebookHtml {
  hasTables: boolean;
  sanitizedHtml: string;
  preservedStylesHtml: string;
  blocks: HtmlOutputBlock[];
}

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

function isEllipsisToken(text: string): boolean {
  const t = text.trim();
  return t === '...' || t === '…';
}

function stripGenericDataframeCss(cssText: string): string {
  // Drop generic Pandas/Polars .dataframe blocks so they cannot leak globally
  // or override user wrap/alignment settings. Preserve #T_... (Styler) or other IDs.
  const withoutDataframeRules = cssText.replace(
    /[^{}]*\.dataframe[^{}]*\{[^}]*\}/gi,
    ''
  );
  return withoutDataframeRules.trim();
}

function isDataTableElement(table: HTMLTableElement): boolean {
  if (table.parentElement?.closest('table')) return false;
  if (table.getAttribute('role') === 'presentation') return false;
  if (table.getAttribute('aria-hidden') === 'true') return false;
  const rows = table.querySelectorAll('tr');
  if (rows.length === 0) return false;
  // Avoid hijacking tiny 1x1 layout tables unless marked as dataframe
  if (
    rows.length === 1 &&
    rows[0].children.length <= 1 &&
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

function findPrimaryHeaderRow(
  thead: HTMLTableSectionElement | null,
  dtypeRow: HTMLTableRowElement | null
): HTMLTableRowElement | null {
  if (!thead) return null;
  const headerRows = Array.from(thead.rows).filter((r) => r !== dtypeRow);
  if (headerRows.length === 0) return null;
  if (headerRows.length === 1) return headerRows[0];

  // Pandas named-index adds a second <thead> row with only the index name filled
  // and empty <th> cells for data columns. Prefer row 0 in that case.
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

function enhanceTableElement(
  table: HTMLTableElement,
  externalShapeLabel: string | null
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
  let dataRowCount = 0;

  let indexPrefixCount = 0;
  let canStickyIndex = bodyRows.length > 0;

  for (const tr of bodyRows) {
    stripBoilerplateTrAlign(tr);
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

      const txt = (cell.textContent || '').trim();
      if (txt && !cell.getAttribute('title')) {
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

  // Verify thead also has a matching 1-cell leading slot for sticky index
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

  // Classify cells and infer per-column types when grid is regular
  const expectedRowLen = primaryHeaderRow ? primaryHeaderRow.cells.length : bodyRows[0]?.cells.length || 0;
  const isUniformGrid =
    expectedRowLen > 0 &&
    !hasRowSpanInBody &&
    !hasColSpanInBody &&
    tbodies.length <= 1 &&
    bodyRows.every((r) => r.cells.length === expectedRowLen) &&
    (!dtypeRow || dtypeRow.cells.length === expectedRowLen) &&
    (!primaryHeaderRow || primaryHeaderRow.cells.length === expectedRowLen);

  // Classify every <td> cell value
  for (const tb of tbodies) {
    for (const tr of Array.from(tb.rows)) {
      const isEllipsis = tr.getAttribute('data-sat-ellipsis-row') === 'true';
      for (const cell of Array.from(tr.cells)) {
        if (cell.tagName === 'TH') {
          cell.setAttribute('data-sat-index-cell', 'true');
          continue;
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

  if (isUniformGrid) {
    const startCol = canStickyIndex ? 1 : 0;
    for (let col = startCol; col < expectedRowLen; col++) {
      let hasNumber = false;
      let hasNonNumberText = false;
      let allEllipsisCol = bodyRows.length > 0;

      for (const tr of bodyRows) {
        if (tr.getAttribute('data-sat-ellipsis-row') === 'true') continue;
        const cell = tr.cells[col];
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
  } else {
    // Fallback for irregular/MultiIndex tables
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
    shapeLabel: externalShapeLabel || defaultShape,
    hasIndexColumn: indexPrefixCount > 0,
    canStickyIndex,
    canSort,
    hasRowSpanInBody,
    hasDtypeRow: Boolean(dtypeRow),
    isTruncated: hasEllipsisRow || Boolean(externalShapeLabel && externalShapeLabel !== defaultShape),
  };
}

export function inspectAndEnhanceHtml(rawHtml: string): ParsedNotebookHtml {
  const sanitizedHtml = DOMPurify.sanitize(rawHtml);
  if (!/<table[\s>]/i.test(sanitizedHtml)) {
    return {
      hasTables: false,
      sanitizedHtml,
      preservedStylesHtml: '',
      blocks: [{ type: 'html', html: sanitizedHtml }],
    };
  }

  const doc = new DOMParser().parseFromString(sanitizedHtml, 'text/html');
  const preservedStyles: string[] = [];

  for (const styleEl of Array.from(doc.querySelectorAll('style'))) {
    const cleaned = stripGenericDataframeCss(styleEl.textContent || '');
    if (cleaned) {
      preservedStyles.push(`<style>${cleaned}</style>`);
    }
    styleEl.remove();
  }

  const allTables = Array.from(doc.body.querySelectorAll('table')).filter(isDataTableElement);
  if (allTables.length === 0) {
    return {
      hasTables: false,
      sanitizedHtml,
      preservedStylesHtml: '',
      blocks: [{ type: 'html', html: sanitizedHtml }],
    };
  }

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

  const flatNodes = flattenContainers(doc.body);
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

    // Check if this is a Polars <small>shape: ...</small> right before a <table>
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
        // Will be consumed by the following <table>
        continue;
      }
    }

    if (el.tagName === 'TABLE' && isDataTableElement(el as HTMLTableElement)) {
      flushHtmlBuffer();

      let externalShape: string | null = null;
      // Look backward for Polars <small>shape: (r, c)</small>
      for (let j = i - 1; j >= 0; j--) {
        const prev = flatNodes[j];
        if (prev.nodeType === Node.TEXT_NODE && !(prev.textContent || '').trim()) continue;
        if (prev.nodeType === Node.ELEMENT_NODE && (prev as HTMLElement).tagName === 'SMALL') {
          externalShape = parseShapeLabel(prev.textContent || '');
        }
        break;
      }

      // Look forward for Pandas <p>R rows × C columns</p>
      for (let j = i + 1; j < flatNodes.length; j++) {
        const next = flatNodes[j];
        if (next.nodeType === Node.TEXT_NODE && !(next.textContent || '').trim()) continue;
        if (next.nodeType === Node.ELEMENT_NODE && (next as HTMLElement).tagName === 'P') {
          const parsedPandas = parseShapeLabel(next.textContent || '');
          if (parsedPandas) {
            if (!externalShape) externalShape = parsedPandas;
            i = j; // consume trailing Pandas dimension summary
          }
        }
        break;
      }

      const meta = enhanceTableElement(el as HTMLTableElement, externalShape);
      blocks.push({
        type: 'table',
        tableHtml: el.outerHTML,
        meta,
      });
      continue;
    }

    htmlBuffer.push(el.outerHTML);
  }

  flushHtmlBuffer();

  return {
    hasTables: blocks.some((b) => b.type === 'table'),
    sanitizedHtml,
    preservedStylesHtml: preservedStyles.join('\n'),
    blocks,
  };
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

export function extractTableDelimited(
  table: HTMLTableElement,
  format: 'tsv' | 'csv' | 'markdown'
): string {
  const headerRows: string[][] = [];
  const bodyRows: string[][] = [];

  if (table.tHead) {
    for (const tr of Array.from(table.tHead.rows)) {
      if (tr.getAttribute('data-sat-dtype-row') === 'true') continue;
      headerRows.push(
        Array.from(tr.cells).map((c) => (c.textContent || '').trim())
      );
    }
  }

  for (const tb of Array.from(table.tBodies)) {
    for (const tr of Array.from(tb.rows)) {
      if (tr.hidden) continue;
      bodyRows.push(
        Array.from(tr.cells).map((c) => (c.textContent || '').trim())
      );
    }
  }

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

  // Markdown
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
    const aNum = Number(a.replace(/,/g, '').replace(/%$/, ''));
    const bNum = Number(b.replace(/,/g, '').replace(/%$/, ''));
    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
      return aNum - bNum;
    }
  }

  return a.localeCompare(b, 'pt-BR', { numeric: true, sensitivity: 'base' });
}
