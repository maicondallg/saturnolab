import { classifyCellValue, extractTableDelimited } from './htmlTableUtils';

export type ExportScope = 'displayed' | 'full';

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseCssColor(cssColor: string | null | undefined): RgbaColor | null {
  if (!cssColor) return null;
  const trimmed = cssColor.trim().toLowerCase();
  if (!trimmed || trimmed === 'transparent' || trimmed === 'none') return null;

  const rgbaMatch = trimmed.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)\s*[,\s]\s*(\d+(?:\.\d+)?)(?:\s*[,/]\s*(\d+(?:\.\d+)?%?))?\s*\)$/
  );
  if (rgbaMatch) {
    const r = Math.min(255, Math.max(0, Math.round(Number(rgbaMatch[1]))));
    const g = Math.min(255, Math.max(0, Math.round(Number(rgbaMatch[2]))));
    const b = Math.min(255, Math.max(0, Math.round(Number(rgbaMatch[3]))));
    let a = 1;
    if (rgbaMatch[4] !== undefined) {
      const rawA = rgbaMatch[4];
      a = rawA.endsWith('%') ? Number(rawA.slice(0, -1)) / 100 : Number(rawA);
    }
    if (a <= 0.01) return null;
    return { r, g, b, a: Math.min(1, Math.max(0, a)) };
  }

  const hexMatch = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.length === 3) {
      return {
        r: parseInt(hex[0] + hex[0], 16),
        g: parseInt(hex[1] + hex[1], 16),
        b: parseInt(hex[2] + hex[2], 16),
        a: 1,
      };
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    if (a <= 0.01) return null;
    return { r, g, b, a };
  }

  return null;
}

function srgbChannelToLinear(c: number): number {
  const norm = c / 255;
  return norm <= 0.04045 ? norm / 12.92 : Math.pow((norm + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(color: RgbaColor): number {
  return (
    0.2126 * srgbChannelToLinear(color.r) +
    0.7152 * srgbChannelToLinear(color.g) +
    0.0722 * srgbChannelToLinear(color.b)
  );
}

export function contrastRatio(c1: RgbaColor, c2: RgbaColor): number {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function rgbToArgbHex(c: RgbaColor): string {
  const toHex = (n: number) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
  return `FF${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`;
}

function sameRgb(a: RgbaColor | null, b: RgbaColor | null): boolean {
  if (!a || !b) return false;
  return Math.abs(a.r - b.r) <= 3 && Math.abs(a.g - b.g) <= 3 && Math.abs(a.b - b.b) <= 3;
}

/**
 * Ensures cells painted via Pandas Styler (e.g. df.style.highlight_max() which sets
 * `background-color: yellow` without setting `color`) remain readable in dark/light themes.
 */
export function ensureReadableStylerContrast(table: HTMLTableElement): void {
  if (typeof window === 'undefined' || !window.getComputedStyle) return;
  const viewport = table.closest('.sat-table-viewport') as HTMLElement | null;
  const baseBg = parseCssColor(
    viewport ? window.getComputedStyle(viewport).backgroundColor : window.getComputedStyle(table).backgroundColor
  );

  for (const tb of Array.from(table.tBodies)) {
    for (const tr of Array.from(tb.rows)) {
      const trBg = parseCssColor(window.getComputedStyle(tr).backgroundColor);
      for (const cell of Array.from(tr.cells)) {
        if (cell.getAttribute('data-sat-auto-contrast') === 'true') {
          cell.style.removeProperty('color');
          cell.removeAttribute('data-sat-auto-contrast');
        }
        const cs = window.getComputedStyle(cell);
        const cellBg = parseCssColor(cs.backgroundColor);
        const effectiveBg = cellBg && cellBg.a > 0.35 ? cellBg : trBg && !sameRgb(trBg, baseBg) ? trBg : null;
        if (!effectiveBg || sameRgb(effectiveBg, baseBg)) continue;

        const fg = parseCssColor(cs.color);
        if (!fg) continue;
        const ratio = contrastRatio(effectiveBg, fg);
        if (ratio < 2.6) {
          const bgLum = relativeLuminance(effectiveBg);
          cell.style.color = bgLum > 0.45 ? '#0f172a' : '#f8fafc';
          cell.setAttribute('data-sat-auto-contrast', 'true');
        }
      }
    }
  }
}

/**
 * Returns the set of tbody rows currently visible inside the scroll container's vertical viewport.
 */
export function getViewportVisibleRows(
  table: HTMLTableElement,
  scrollEl: HTMLElement | null
): Set<HTMLTableRowElement> {
  const result = new Set<HTMLTableRowElement>();
  const allVisibleRows: HTMLTableRowElement[] = [];
  for (const tb of Array.from(table.tBodies)) {
    for (const tr of Array.from(tb.rows)) {
      if (!tr.hidden) {
        allVisibleRows.push(tr);
      }
    }
  }

  if (!scrollEl || scrollEl.scrollHeight <= scrollEl.clientHeight + 4) {
    for (const r of allVisibleRows) result.add(r);
    return result;
  }

  const scrollRect = scrollEl.getBoundingClientRect();
  const theadHeight = table.tHead ? table.tHead.getBoundingClientRect().height : 0;
  const topBound = scrollRect.top + theadHeight - 4;
  const bottomBound = scrollRect.bottom + 4;

  for (const tr of allVisibleRows) {
    const r = tr.getBoundingClientRect();
    if (r.height > 0 && r.bottom > topBound && r.top < bottomBound) {
      result.add(tr);
    }
  }

  if (result.size === 0) {
    for (const r of allVisibleRows) result.add(r);
  }
  return result;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadTableCsv(
  table: HTMLTableElement,
  scrollEl: HTMLElement | null,
  scope: ExportScope,
  hasFilter: boolean,
  filename = 'tabela.csv'
): void {
  const useViewportSubset =
    scope === 'displayed' &&
    !hasFilter &&
    Boolean(scrollEl && scrollEl.scrollHeight > scrollEl.clientHeight + 4);

  const visibleRowSet = useViewportSubset ? getViewportVisibleRows(table, scrollEl) : undefined;
  const csv = extractTableDelimited(table, 'csv', {
    includeHiddenRows: scope === 'full',
    includeHiddenCols: scope === 'full',
    visibleRowSet,
  });
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  triggerBlobDownload(blob, filename);
}

// ============================================================================
// Pure TypeScript OpenXML (.xlsx) Generator with Styles & Typed Numbers
// ============================================================================

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipArchive(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = file.data;
    const crc = crc32(data);

    // Local file header (30 bytes + name)
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 flag
    lv.setUint16(8, 0, true); // compression: STORE
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0x21, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    // Central directory header (46 bytes + name)
    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, data);
    centralParts.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralSize = centralParts.reduce((acc, p) => acc + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalLen = offset + centralSize + eocd.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.length;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.length;
  }
  out.set(eocd, pos);
  return out;
}

function escapeXml(str: string): string {
  return str
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function excelColName(colIndexZeroBased: number): string {
  let n = colIndexZeroBased + 1;
  let name = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function buildTableXlsxBytes(
  table: HTMLTableElement,
  scrollEl: HTMLElement | null,
  scope: ExportScope,
  hasFilter: boolean
): Uint8Array {
  const includeHiddenRows = scope === 'full';
  const includeHiddenCols = scope === 'full';
  const useViewportSubset =
    scope === 'displayed' &&
    !hasFilter &&
    Boolean(scrollEl && scrollEl.scrollHeight > scrollEl.clientHeight + 4);
  const visibleRowSet = useViewportSubset ? getViewportVisibleRows(table, scrollEl) : undefined;

  const viewport = table.closest('.sat-table-viewport') as HTMLElement | null;
  const baseBg =
    typeof window !== 'undefined' && window.getComputedStyle
      ? parseCssColor(
          viewport
            ? window.getComputedStyle(viewport).backgroundColor
            : window.getComputedStyle(table).backgroundColor
        )
      : null;

  interface CellExportItem {
    text: string;
    isHeader: boolean;
    bgArgb: string | null;
    fgArgb: string | null;
  }

  const rows: CellExportItem[][] = [];

  const collectRowCells = (tr: HTMLTableRowElement, isHeader: boolean): CellExportItem[] => {
    const trBg =
      !isHeader && typeof window !== 'undefined' && window.getComputedStyle
        ? parseCssColor(window.getComputedStyle(tr).backgroundColor)
        : null;

    return Array.from(tr.cells)
      .filter((c) => includeHiddenCols || (!c.hidden && c.getAttribute('data-sat-col-hidden') !== 'true'))
      .map((cell) => {
        const text = (cell.textContent || '').trim();
        let bgArgb: string | null = null;
        let fgArgb: string | null = null;

        if (!isHeader && typeof window !== 'undefined' && window.getComputedStyle) {
          const cs = window.getComputedStyle(cell);
          const cBg = parseCssColor(cs.backgroundColor);
          const effectiveBg = cBg && cBg.a > 0.35 ? cBg : trBg && !sameRgb(trBg, baseBg) ? trBg : null;
          if (effectiveBg && !sameRgb(effectiveBg, baseBg)) {
            bgArgb = rgbToArgbHex(effectiveBg);
            const cFg = parseCssColor(cs.color);
            if (cFg) {
              fgArgb = rgbToArgbHex(cFg);
            }
          }
        }
        return { text, isHeader, bgArgb, fgArgb };
      });
  };

  if (table.tHead) {
    for (const tr of Array.from(table.tHead.rows)) {
      if (tr.getAttribute('data-sat-dtype-row') === 'true') continue;
      rows.push(collectRowCells(tr, true));
    }
  }

  for (const tb of Array.from(table.tBodies)) {
    for (const tr of Array.from(tb.rows)) {
      if (!includeHiddenRows && tr.hidden) continue;
      if (visibleRowSet && !visibleRowSet.has(tr)) continue;
      rows.push(collectRowCells(tr, false));
    }
  }

  // Style registry
  const fonts: string[] = [
    '<font><sz val="11"/><name val="Calibri"/></font>', // 0: default
    '<font><b/><sz val="11"/><color rgb="FF1F2937"/><name val="Calibri"/></font>', // 1: header
  ];
  const fontIndexByKey = new Map<string, number>();
  fontIndexByKey.set('default', 0);
  fontIndexByKey.set('header', 1);

  const fills: string[] = [
    '<fill><patternFill patternType="none"/></fill>', // 0: required
    '<fill><patternFill patternType="gray125"/></fill>', // 1: required
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>', // 2: header
  ];
  const fillIndexByArgb = new Map<string, number>();
  fillIndexByArgb.set('HEADER', 2);

  const xfs: string[] = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>', // 0: normal
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>', // 1: header
  ];
  const xfIndexByKey = new Map<string, number>();
  xfIndexByKey.set('0:0:0', 0);
  xfIndexByKey.set('1:2:1', 1);

  const getStyleIndex = (item: CellExportItem): number => {
    if (item.isHeader) return 1;
    if (!item.bgArgb && !item.fgArgb) return 0;

    let fontId = 0;
    if (item.fgArgb) {
      const fKey = `fg:${item.fgArgb}`;
      let existingFont = fontIndexByKey.get(fKey);
      if (existingFont === undefined) {
        existingFont = fonts.length;
        fonts.push(`<font><sz val="11"/><color rgb="${item.fgArgb}"/><name val="Calibri"/></font>`);
        fontIndexByKey.set(fKey, existingFont);
      }
      fontId = existingFont;
    }

    let fillId = 0;
    if (item.bgArgb) {
      let existingFill = fillIndexByArgb.get(item.bgArgb);
      if (existingFill === undefined) {
        existingFill = fills.length;
        fills.push(
          `<fill><patternFill patternType="solid"><fgColor rgb="${item.bgArgb}"/><bgColor indexed="64"/></patternFill></fill>`
        );
        fillIndexByArgb.set(item.bgArgb, existingFill);
      }
      fillId = existingFill;
    }

    const xfKey = `${fontId}:${fillId}:0`;
    let xfIdx = xfIndexByKey.get(xfKey);
    if (xfIdx === undefined) {
      xfIdx = xfs.length;
      xfs.push(
        `<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0" applyFont="${
          fontId > 0 ? 1 : 0
        }" applyFill="${fillId > 0 ? 1 : 0}"/>`
      );
      xfIndexByKey.set(xfKey, xfIdx);
    }
    return xfIdx;
  };

  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  const colCharWidths = new Array<number>(maxCols).fill(10);

  const sheetRowsXml: string[] = [];
  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    const rowNum = rIdx + 1;
    const cellsXml: string[] = [];

    for (let cIdx = 0; cIdx < row.length; cIdx++) {
      const item = row[cIdx];
      const ref = `${excelColName(cIdx)}${rowNum}`;
      const sIdx = getStyleIndex(item);
      const val = item.text;
      colCharWidths[cIdx] = Math.min(50, Math.max(colCharWidths[cIdx], val.length + 3));

      if (!item.isHeader && classifyCellValue(val) === 'number' && !val.endsWith('%')) {
        const cleanedNum = Number(val.replace(/,/g, ''));
        if (Number.isFinite(cleanedNum)) {
          cellsXml.push(`<c r="${ref}" s="${sIdx}" t="n"><v>${cleanedNum}</v></c>`);
          continue;
        }
      }

      cellsXml.push(
        `<c r="${ref}" s="${sIdx}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(val)}</t></is></c>`
      );
    }

    sheetRowsXml.push(`<row r="${rowNum}">${cellsXml.join('')}</row>`);
  }

  const colsXml =
    maxCols > 0
      ? `<cols>${colCharWidths
          .map((w, idx) => `<col min="${idx + 1}" max="${idx + 1}" width="${w}" customWidth="1"/>`)
          .join('')}</cols>`
      : '';

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Tabela" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="${fonts.length}">${fonts.join('')}</fonts>
  <fills count="${fills.length}">${fills.join('')}</fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>
</styleSheet>`;

  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${colsXml}
  <sheetData>${sheetRowsXml.join('')}</sheetData>
</worksheet>`;

  const enc = new TextEncoder();
  return createZipArchive([
    { name: '[Content_Types].xml', data: enc.encode(contentTypesXml) },
    { name: '_rels/.rels', data: enc.encode(relsXml) },
    { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRelsXml) },
    { name: 'xl/styles.xml', data: enc.encode(stylesXml) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(worksheetXml) },
  ]);
}

export function downloadTableXlsx(
  table: HTMLTableElement,
  scrollEl: HTMLElement | null,
  scope: ExportScope,
  hasFilter: boolean,
  filename = 'tabela.xlsx'
): void {
  const bytes = buildTableXlsxBytes(table, scrollEl, scope, hasFilter);
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  triggerBlobDownload(blob, filename);
}

// ============================================================================
// High-DPI Canvas 2D Table PNG Renderer (Displayed Viewport vs Full Table)
// ============================================================================

function drawCellLinearGradient(
  ctx: CanvasRenderingContext2D,
  bgImage: string,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  if (!bgImage || !bgImage.includes('linear-gradient')) return;
  // Match Pandas df.style.bar() gradients e.g. linear-gradient(90deg, rgb(214, 95, 95) 50%, rgba(0, 0, 0, 0) 50%)
  const stopRegex = /(rgba?\([^)]+\)|#[0-9a-fA-F]{3,8})\s+(\d+(?:\.\d+)?)%/g;
  const stops: { color: string; pct: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = stopRegex.exec(bgImage)) !== null) {
    stops.push({ color: match[1], pct: Number(match[2]) / 100 });
  }
  if (stops.length === 0) return;

  // Check if it is a sharp bar stop (two stops at same percentage, or first color stop up to pct)
  const firstColor = parseCssColor(stops[0].color);
  if (firstColor && stops.length >= 2 && Math.abs(stops[0].pct - stops[1].pct) < 0.01) {
    const barW = Math.max(0, Math.min(w, w * stops[0].pct));
    if (barW > 0) {
      ctx.fillStyle = `rgba(${firstColor.r}, ${firstColor.g}, ${firstColor.b}, ${firstColor.a})`;
      ctx.fillRect(x, y, barW, h);
    }
    return;
  }

  const grad = ctx.createLinearGradient(x, y, x + w, y);
  for (const s of stops) {
    const c = parseCssColor(s.color);
    grad.addColorStop(
      Math.min(1, Math.max(0, s.pct)),
      c ? `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})` : 'rgba(0,0,0,0)'
    );
  }
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  if (maxWidth <= 4) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (ctx.measureText(word).width > maxWidth) {
        // Break long token
        let chunk = '';
        for (const ch of word) {
          if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else {
            chunk += ch;
          }
        }
        current = chunk;
      } else {
        current = word;
      }
    }
  }
  if (current || lines.length === 0) lines.push(current);
  return lines;
}

function truncateCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string {
  if (maxWidth <= 4 || ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = '…';
  const ellW = ctx.measureText(ellipsis).width;
  if (ellW >= maxWidth) return ellipsis;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid)).width + ellW <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo) + ellipsis;
}

function paintCellOnCanvas(
  ctx: CanvasRenderingContext2D,
  cell: HTMLTableCellElement,
  tr: HTMLTableRowElement,
  x: number,
  y: number,
  w: number,
  h: number,
  fallbackBg: string
): void {
  if (w <= 0 || h <= 0) return;
  const cs = window.getComputedStyle(cell);
  const trCs = window.getComputedStyle(tr);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  // 1. Base / row background
  ctx.fillStyle = fallbackBg;
  ctx.fillRect(x, y, w, h);

  const rowBg = parseCssColor(trCs.backgroundColor);
  if (rowBg) {
    ctx.fillStyle = `rgba(${rowBg.r}, ${rowBg.g}, ${rowBg.b}, ${rowBg.a})`;
    ctx.fillRect(x, y, w, h);
  }

  // 2. Cell background color (Pandas Styler / header / index)
  const cellBg = parseCssColor(cs.backgroundColor);
  if (cellBg) {
    ctx.fillStyle = `rgba(${cellBg.r}, ${cellBg.g}, ${cellBg.b}, ${cellBg.a})`;
    ctx.fillRect(x, y, w, h);
  }

  // 3. Cell linear-gradient (e.g. Pandas df.style.bar())
  if (cs.backgroundImage && cs.backgroundImage !== 'none') {
    drawCellLinearGradient(ctx, cs.backgroundImage, x, y, w, h);
  }

  // 4. Borders
  const bBottomW = parseFloat(cs.borderBottomWidth) || 0;
  if (bBottomW > 0 && cs.borderBottomStyle !== 'none') {
    ctx.fillStyle = cs.borderBottomColor || 'rgba(128,128,128,0.2)';
    ctx.fillRect(x, y + h - bBottomW, w, bBottomW);
  }
  const bRightW = parseFloat(cs.borderRightWidth) || 0;
  if (bRightW > 0 && cs.borderRightStyle !== 'none') {
    ctx.fillStyle = cs.borderRightColor || 'rgba(128,128,128,0.2)';
    ctx.fillRect(x + w - bRightW, y, bRightW, h);
  }

  // 5. Text content
  let rawText = (cell.textContent || '').trim();
  const sortDir = cell.getAttribute('data-sat-sort');
  if (sortDir === 'asc') rawText += ' ▲';
  else if (sortDir === 'desc') rawText += ' ▼';

  if (rawText) {
    const padL = parseFloat(cs.paddingLeft) || 8;
    const padR = parseFloat(cs.paddingRight) || 8;
    const fontSize = parseFloat(cs.fontSize) || 13;
    const fontStyle = cs.fontStyle || 'normal';
    const fontWeight = cs.fontWeight || '400';
    const fontFamily = cs.fontFamily || 'sans-serif';

    ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.fillStyle = cs.color || '#e5e7eb';
    ctx.textBaseline = 'middle';

    const align = cs.textAlign || 'left';
    const contentW = Math.max(0, w - padL - padR);
    const isWrap = cs.whiteSpace !== 'nowrap';

    const lines = isWrap
      ? wrapCanvasText(ctx, rawText, contentW)
      : [truncateCanvasText(ctx, rawText, contentW)];

    const lineHeight = fontSize * 1.35;
    const totalTextH = lines.length * lineHeight;
    let startY = y + (h - totalTextH) / 2 + lineHeight / 2;

    for (const line of lines) {
      let tx = x + padL;
      if (align === 'right' || align === 'end') {
        tx = x + w - padR - ctx.measureText(line).width;
      } else if (align === 'center') {
        tx = x + padL + (contentW - ctx.measureText(line).width) / 2;
      }
      ctx.fillText(line, tx, startY);
      startY += lineHeight;
    }
  }

  ctx.restore();
}

export async function renderTableToPngBlob(
  viewportEl: HTMLElement,
  scrollEl: HTMLElement,
  table: HTMLTableElement,
  preservedStylesHtml: string,
  scope: ExportScope
): Promise<Blob | null> {
  let offscreenHost: HTMLDivElement | null = null;
  let targetViewport = viewportEl;
  let targetScroll = scrollEl;
  let targetTable = table;

  try {
    if (scope === 'full') {
      offscreenHost = document.createElement('div');
      offscreenHost.className = viewportEl.className;
      for (const attr of Array.from(viewportEl.attributes)) {
        if (attr.name.startsWith('data-')) {
          offscreenHost.setAttribute(attr.name, attr.value);
        }
      }
      offscreenHost.setAttribute('data-sticky', 'false');
      offscreenHost.style.cssText = viewportEl.style.cssText;
      if (offscreenHost.getAttribute('data-wrap') === 'nowrap') {
        offscreenHost.style.setProperty('--sat-table-max-col-w', 'none');
      }
      offscreenHost.style.position = 'fixed';
      offscreenHost.style.left = '-99999px';
      offscreenHost.style.top = '0';
      offscreenHost.style.width = 'max-content';
      offscreenHost.style.minWidth = `${Math.ceil(table.getBoundingClientRect().width)}px`;
      offscreenHost.style.maxWidth = 'none';
      offscreenHost.style.height = 'auto';
      offscreenHost.style.maxHeight = 'none';
      offscreenHost.style.overflow = 'visible';
      offscreenHost.style.zIndex = '-1';
      offscreenHost.style.pointerEvents = 'none';

      const innerHost = document.createElement('div');
      innerHost.className = 'sat-table-host';
      if (preservedStylesHtml) {
        const styleContainer = document.createElement('div');
        styleContainer.innerHTML = preservedStylesHtml;
        innerHost.appendChild(styleContainer);
      }

      const clonedTable = table.cloneNode(true) as HTMLTableElement;
      for (const tb of Array.from(clonedTable.tBodies)) {
        for (const tr of Array.from(tb.rows)) {
          tr.hidden = false;
          for (const c of Array.from(tr.cells)) {
            c.hidden = false;
            c.removeAttribute('data-sat-col-hidden');
          }
        }
      }
      if (clonedTable.tHead) {
        for (const tr of Array.from(clonedTable.tHead.rows)) {
          for (const c of Array.from(tr.cells)) {
            c.hidden = false;
            c.removeAttribute('data-sat-col-hidden');
          }
        }
      }

      innerHost.appendChild(clonedTable);
      offscreenHost.appendChild(innerHost);
      document.body.appendChild(offscreenHost);
      ensureReadableStylerContrast(clonedTable);

      targetViewport = offscreenHost;
      targetScroll = offscreenHost;
      targetTable = clonedTable;
    }

    const viewportCs = window.getComputedStyle(targetViewport);
    const fallbackBg = viewportCs.backgroundColor || '#18181b';
    const borderColor = window.getComputedStyle(targetTable).borderColor || 'rgba(128,128,128,0.25)';

    const tableRect = targetTable.getBoundingClientRect();
    const scrollRect = targetScroll.getBoundingClientRect();

    const logicalW =
      scope === 'full'
        ? Math.ceil(tableRect.width)
        : Math.ceil(Math.min(targetScroll.clientWidth || tableRect.width, tableRect.width));
    const logicalH =
      scope === 'full'
        ? Math.ceil(tableRect.height)
        : Math.ceil(Math.min(targetScroll.clientHeight || tableRect.height, tableRect.height));

    if (logicalW <= 0 || logicalH <= 0) return null;

    // Cap scale so huge full-table exports never exceed browser canvas limits (max ~16384px)
    const maxDim = Math.max(logicalW, logicalH);
    const scale = maxDim > 7500 ? 1 : maxDim > 4000 ? 1.5 : 2;

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(logicalW * scale);
    canvas.height = Math.round(logicalH * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.scale(scale, scale);
    ctx.fillStyle = fallbackBg;
    ctx.fillRect(0, 0, logicalW, logicalH);

    const originX = scope === 'full' ? tableRect.left : scrollRect.left;
    const originY = scope === 'full' ? tableRect.top : scrollRect.top;

    // Layer 1: Non-sticky tbody cells
    for (const tb of Array.from(targetTable.tBodies)) {
      for (const tr of Array.from(tb.rows)) {
        if (tr.hidden) continue;
        for (const cell of Array.from(tr.cells)) {
          if (cell.hidden || cell.getAttribute('data-sat-col-hidden') === 'true') continue;
          if (cell.getAttribute('data-sat-sticky-index') === 'true') continue;
          const r = cell.getBoundingClientRect();
          const x = r.left - originX;
          const y = r.top - originY;
          if (x + r.width < 0 || y + r.height < 0 || x > logicalW || y > logicalH) continue;
          paintCellOnCanvas(ctx, cell, tr, x, y, r.width, r.height, fallbackBg);
        }
      }
    }

    // Layer 2: Sticky index tbody cells
    for (const tb of Array.from(targetTable.tBodies)) {
      for (const tr of Array.from(tb.rows)) {
        if (tr.hidden) continue;
        for (const cell of Array.from(tr.cells)) {
          if (cell.hidden || cell.getAttribute('data-sat-col-hidden') === 'true') continue;
          if (cell.getAttribute('data-sat-sticky-index') !== 'true') continue;
          const r = cell.getBoundingClientRect();
          const x = r.left - originX;
          const y = r.top - originY;
          if (x + r.width < 0 || y + r.height < 0 || x > logicalW || y > logicalH) continue;
          paintCellOnCanvas(ctx, cell, tr, x, y, r.width, r.height, fallbackBg);
        }
      }
    }

    // Layer 3: Non-sticky thead cells
    if (targetTable.tHead) {
      for (const tr of Array.from(targetTable.tHead.rows)) {
        if (tr.hidden) continue;
        for (const cell of Array.from(tr.cells)) {
          if (cell.hidden || cell.getAttribute('data-sat-col-hidden') === 'true') continue;
          if (cell.getAttribute('data-sat-sticky-index') === 'true') continue;
          const r = cell.getBoundingClientRect();
          const x = r.left - originX;
          const y = r.top - originY;
          if (x + r.width < 0 || y + r.height < 0 || x > logicalW || y > logicalH) continue;
          paintCellOnCanvas(ctx, cell, tr, x, y, r.width, r.height, fallbackBg);
        }
      }

      // Layer 4: Sticky corner thead cells
      for (const tr of Array.from(targetTable.tHead.rows)) {
        if (tr.hidden) continue;
        for (const cell of Array.from(tr.cells)) {
          if (cell.hidden || cell.getAttribute('data-sat-col-hidden') === 'true') continue;
          if (cell.getAttribute('data-sat-sticky-index') !== 'true') continue;
          const r = cell.getBoundingClientRect();
          const x = r.left - originX;
          const y = r.top - originY;
          if (x + r.width < 0 || y + r.height < 0 || x > logicalW || y > logicalH) continue;
          paintCellOnCanvas(ctx, cell, tr, x, y, r.width, r.height, fallbackBg);
        }
      }
    }

    // Outer frame border
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, logicalW - 1, logicalH - 1);

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/png');
    });
  } finally {
    if (offscreenHost && offscreenHost.parentNode) {
      offscreenHost.parentNode.removeChild(offscreenHost);
    }
  }
}

export async function downloadTablePng(
  viewportEl: HTMLElement,
  scrollEl: HTMLElement,
  table: HTMLTableElement,
  preservedStylesHtml: string,
  scope: ExportScope,
  filename = 'tabela.png'
): Promise<boolean> {
  const blob = await renderTableToPngBlob(viewportEl, scrollEl, table, preservedStylesHtml, scope);
  if (!blob) return false;
  triggerBlobDownload(blob, filename);
  return true;
}

export async function copyTablePngToClipboard(
  viewportEl: HTMLElement,
  scrollEl: HTMLElement,
  table: HTMLTableElement,
  preservedStylesHtml: string,
  scope: ExportScope
): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    return false;
  }
  try {
    const blob = await renderTableToPngBlob(viewportEl, scrollEl, table, preservedStylesHtml, scope);
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}
