import { CellOutput, NotebookCellData } from '../types/notebook';

export interface MinimapMetrics {
  scale: number;
  contentHeight: number;
  viewportHeight: number;
  mapHeight: number;
  virtualHeight: number;
  trackSpan: number;
  maxScrollTop: number;
  scrollTop: number;
  progress: number;
  mapScrollOffset: number;
  lensTop: number;
  lensHeight: number;
  hasOverflow: boolean;
}

export interface MinimapMetricsInput {
  contentHeight: number;
  viewportHeight: number;
  mapHeight: number;
  scrollTop: number;
  baseScale: number;
  minScale: number;
  minLensHeight?: number;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Computes unified minimap scale, virtual height, internal pan offset, and viewport lens geometry.
 * Works continuously across short documents (natural baseScale), medium documents (fit-to-height),
 * and huge documents (clamped to minScale with proportional internal minimap panning).
 */
export function computeMinimapMetrics({
  contentHeight,
  viewportHeight,
  mapHeight,
  scrollTop,
  baseScale,
  minScale,
  minLensHeight = 24,
}: MinimapMetricsInput): MinimapMetrics {
  const safeContent = Math.max(1, contentHeight);
  const safeViewport = Math.max(1, viewportHeight);
  const safeMap = Math.max(1, mapHeight);
  const maxScrollTop = Math.max(0, safeContent - safeViewport);
  const clampedScroll = clamp(scrollTop, 0, maxScrollTop);
  const hasOverflow = maxScrollTop > 1;

  let scale = baseScale;
  if (safeContent * baseScale > safeMap) {
    scale = Math.max(minScale, safeMap / safeContent);
  }

  const virtualHeight = Math.max(1, safeContent * scale);
  const trackSpan = Math.min(safeMap, virtualHeight);
  const progress = hasOverflow ? clampedScroll / maxScrollTop : 0;
  const mapScrollOffset = Math.max(0, virtualHeight - safeMap) * progress;

  const rawLensHeight = safeViewport * scale;
  const lensHeight = hasOverflow
    ? clamp(rawLensHeight, Math.min(minLensHeight, trackSpan), trackSpan)
    : trackSpan;
  const lensTop = hasOverflow ? progress * Math.max(0, trackSpan - lensHeight) : 0;

  return {
    scale,
    contentHeight: safeContent,
    viewportHeight: safeViewport,
    mapHeight: safeMap,
    virtualHeight,
    trackSpan,
    maxScrollTop,
    scrollTop: clampedScroll,
    progress,
    mapScrollOffset,
    lensTop,
    lensHeight,
    hasOverflow,
  };
}

export function scrollTopFromPointerClick(
  localY: number,
  metrics: MinimapMetrics
): number {
  if (!metrics.hasOverflow) return 0;
  const clampedY = clamp(localY, 0, metrics.trackSpan);
  const virtualY = clampedY + metrics.mapScrollOffset;
  const docY = virtualY / Math.max(1e-6, metrics.scale);
  return clamp(docY - metrics.viewportHeight / 2, 0, metrics.maxScrollTop);
}

export function scrollTopFromLensDrag(
  moveLocalY: number,
  grabOffset: number,
  metrics: MinimapMetrics
): number {
  if (!metrics.hasOverflow) return 0;
  const travel = Math.max(1, metrics.trackSpan - metrics.lensHeight);
  const desiredLensTop = clamp(moveLocalY - grabOffset, 0, travel);
  const nextProgress = desiredLensTop / travel;
  return clamp(nextProgress * metrics.maxScrollTop, 0, metrics.maxScrollTop);
}

/**
 * Computes an accelerated scroll delta when wheel-scrolling directly inside the minimap.
 * Scales adaptively with the document compression (~4x on medium docs up to 10x on huge docs)
 * so navigating long notebooks and files via the minimap is markedly faster than normal scroll.
 */
export function computeFastWheelDelta(
  deltaY: number,
  deltaMode: number,
  metrics: MinimapMetrics
): number {
  if (!deltaY || !metrics.hasOverflow) return 0;
  const basePixels =
    deltaMode === 1
      ? deltaY * 24
      : deltaMode === 2
        ? deltaY * metrics.viewportHeight
        : deltaY;
  const speedBoost = clamp(0.55 / Math.max(0.01, metrics.scale), 4, 10);
  return basePixels * speedBoost;
}

export interface MinimapPalette {
  bgCanvas: string;
  bgSurface: string;
  bgSubtle: string;
  cellBg: string;
  cellActiveBg: string;
  border: string;
  borderStrong: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentSoft: string;
  cmdBar: string;
  editBar: string;
  green: string;
  errorBg: string;
  errorBorder: string;
  errorText: string;
  synKeyword: string;
  synString: string;
  synNumber: string;
  synComment: string;
  synFunction: string;
  synClass: string;
  synBuiltin: string;
  typeMd: string;
  typePy: string;
  typeData: string;
}

function readVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const val = styles.getPropertyValue(name).trim();
  return val || fallback;
}

export function readMinimapPalette(): MinimapPalette {
  if (typeof window === 'undefined' || !document.documentElement) {
    return {
      bgCanvas: '#141416',
      bgSurface: '#1b1b1e',
      bgSubtle: '#222226',
      cellBg: '#18181b',
      cellActiveBg: '#1c1c20',
      border: '#2e2e34',
      borderStrong: '#52525b',
      textPrimary: '#e4e4e7',
      textSecondary: '#a1a1aa',
      textMuted: '#71717a',
      accent: '#d97736',
      accentSoft: 'rgba(217, 119, 54, 0.14)',
      cmdBar: '#a1a1aa',
      editBar: '#d97736',
      green: '#4d9375',
      errorBg: '#241618',
      errorBorder: '#5c282e',
      errorText: '#f3a6ad',
      synKeyword: '#ff7b72',
      synString: '#a5d6ff',
      synNumber: '#79c0ff',
      synComment: '#6e7681',
      synFunction: '#d2a8ff',
      synClass: '#ffa657',
      synBuiltin: '#79c0ff',
      typeMd: '#c084fc',
      typePy: '#58a6ff',
      typeData: '#3fb950',
    };
  }
  const s = window.getComputedStyle(document.documentElement);
  return {
    bgCanvas: readVar(s, '--sat-bg-canvas', '#141416'),
    bgSurface: readVar(s, '--sat-bg-surface', '#1b1b1e'),
    bgSubtle: readVar(s, '--sat-bg-subtle', '#222226'),
    cellBg: readVar(s, '--sat-cell-bg', '#18181b'),
    cellActiveBg: readVar(s, '--sat-cell-active-bg', '#1c1c20'),
    border: readVar(s, '--sat-border', '#2e2e34'),
    borderStrong: readVar(s, '--sat-border-strong', '#52525b'),
    textPrimary: readVar(s, '--sat-text-primary', '#e4e4e7'),
    textSecondary: readVar(s, '--sat-text-secondary', '#a1a1aa'),
    textMuted: readVar(s, '--sat-text-muted', '#71717a'),
    accent: readVar(s, '--sat-accent', '#d97736'),
    accentSoft: readVar(s, '--sat-accent-soft', 'rgba(217, 119, 54, 0.14)'),
    cmdBar: readVar(s, '--sat-cmd-bar', '#a1a1aa'),
    editBar: readVar(s, '--sat-edit-bar', '#d97736'),
    green: readVar(s, '--sat-green', '#4d9375'),
    errorBg: readVar(s, '--sat-error-bg', '#241618'),
    errorBorder: readVar(s, '--sat-error-border', '#5c282e'),
    errorText: readVar(s, '--sat-error-text', '#f3a6ad'),
    synKeyword: readVar(s, '--sat-syn-keyword', '#ff7b72'),
    synString: readVar(s, '--sat-syn-string', '#a5d6ff'),
    synNumber: readVar(s, '--sat-syn-number', '#79c0ff'),
    synComment: readVar(s, '--sat-syn-comment', '#6e7681'),
    synFunction: readVar(s, '--sat-syn-function', '#d2a8ff'),
    synClass: readVar(s, '--sat-syn-class', '#ffa657'),
    synBuiltin: readVar(s, '--sat-syn-builtin', '#79c0ff'),
    typeMd: readVar(s, '--sat-type-md', '#c084fc'),
    typePy: readVar(s, '--sat-type-py', '#58a6ff'),
    typeData: readVar(s, '--sat-type-data', '#3fb950'),
  };
}

export type MinimapTokenRole =
  | 'normal'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'class'
  | 'heading1'
  | 'heading2'
  | 'heading3';

export interface MinimapTokenSpan {
  col: number;
  len: number;
  role: MinimapTokenRole;
}

export type MinimapLanguage = 'python' | 'markdown' | 'json' | 'text';

const PY_KEYWORDS = new Set([
  'def',
  'class',
  'import',
  'from',
  'as',
  'return',
  'yield',
  'if',
  'elif',
  'else',
  'for',
  'while',
  'in',
  'not',
  'and',
  'or',
  'is',
  'try',
  'except',
  'finally',
  'raise',
  'with',
  'async',
  'await',
  'lambda',
  'pass',
  'break',
  'continue',
  'None',
  'True',
  'False',
]);

const MAX_SCAN_CHARS = 120;

export function tokenizeMinimapLine(
  rawLine: string,
  language: MinimapLanguage
): MinimapTokenSpan[] {
  if (!rawLine) return [];
  const line = rawLine.length > MAX_SCAN_CHARS ? rawLine.slice(0, MAX_SCAN_CHARS) : rawLine;
  const len = line.length;
  let i = 0;
  let col = 0;

  while (i < len && (line[i] === ' ' || line[i] === '\t')) {
    col += line[i] === '\t' ? 4 : 1;
    i++;
  }
  if (i >= len) return [];

  if (language === 'markdown') {
    const rest = line.slice(i);
    const headingMatch = rest.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const role: MinimapTokenRole =
        depth === 1 ? 'heading1' : depth === 2 ? 'heading2' : 'heading3';
      return [{ col, len: Math.max(4, rest.trimEnd().length), role }];
    }
    if (rest.startsWith('```')) {
      return [{ col, len: Math.max(6, rest.trimEnd().length), role: 'keyword' }];
    }
    if (/^[-*+]\s+/.test(rest) || /^\d+\.\s+/.test(rest)) {
      return [
        { col, len: 2, role: 'keyword' },
        { col: col + 3, len: Math.max(2, rest.trimEnd().length - 3), role: 'normal' },
      ];
    }
    return [{ col, len: rest.trimEnd().length, role: 'normal' }];
  }

  if (language === 'json') {
    const spans: MinimapTokenSpan[] = [];
    const trimmed = line.slice(i).trimEnd();
    const keyMatch = trimmed.match(/^("[^"]*")\s*:\s*(.*)$/);
    if (keyMatch) {
      const keyLen = keyMatch[1].length;
      spans.push({ col, len: keyLen, role: 'function' });
      const val = keyMatch[2];
      if (val) {
        const valCol = col + keyLen + 2;
        const role: MinimapTokenRole = val.startsWith('"')
          ? 'string'
          : /^-?\d/.test(val)
            ? 'number'
            : /^(true|false|null)/.test(val)
              ? 'keyword'
              : 'normal';
        spans.push({ col: valCol, len: val.length, role });
      }
      return spans;
    }
    return [{ col, len: trimmed.length, role: 'normal' }];
  }

  if (language === 'text') {
    const trimmed = line.slice(i).trimEnd();
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      return [{ col, len: trimmed.length, role: 'comment' }];
    }
    return [{ col, len: trimmed.length, role: 'normal' }];
  }

  // Python fast tokenizer
  const spans: MinimapTokenSpan[] = [];
  let expectNameRole: 'function' | 'class' | null = null;

  while (i < len) {
    const ch = line[i];
    if (ch === ' ' || ch === '\t') {
      col += ch === '\t' ? 4 : 1;
      i++;
      continue;
    }

    // Comment
    if (ch === '#') {
      const rem = line.slice(i).trimEnd().length;
      if (rem > 0) spans.push({ col, len: rem, role: 'comment' });
      break;
    }

    // Decorator
    if (ch === '@' && spans.length === 0) {
      const rem = line.slice(i).trimEnd().length;
      spans.push({ col, len: rem, role: 'class' });
      break;
    }

    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const startCol = col;
      let j = i + 1;
      while (j < len) {
        if (line[j] === '\\') {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j++;
          break;
        }
        j++;
      }
      const segLen = Math.max(1, j - i);
      spans.push({ col: startCol, len: segLen, role: 'string' });
      col += segLen;
      i = j;
      expectNameRole = null;
      continue;
    }

    // Number literal
    if (ch >= '0' && ch <= '9') {
      const startCol = col;
      let j = i + 1;
      while (j < len && /[0-9._eExXbBoOa-fA-F]/.test(line[j])) j++;
      const segLen = j - i;
      spans.push({ col: startCol, len: segLen, role: 'number' });
      col += segLen;
      i = j;
      expectNameRole = null;
      continue;
    }

    // Identifier / keyword
    if (/[a-zA-Z_]/.test(ch)) {
      const startCol = col;
      let j = i + 1;
      while (j < len && /[a-zA-Z0-9_]/.test(line[j])) j++;
      const word = line.slice(i, j);
      let role: MinimapTokenRole = 'normal';
      if (expectNameRole) {
        role = expectNameRole;
        expectNameRole = null;
      } else if (PY_KEYWORDS.has(word)) {
        role = 'keyword';
        if (word === 'def') expectNameRole = 'function';
        else if (word === 'class') expectNameRole = 'class';
      } else if (j < len && line[j] === '(') {
        role = 'function';
      }
      spans.push({ col: startCol, len: word.length, role });
      col += word.length;
      i = j;
      continue;
    }

    // Operators / punctuation burst
    const startCol = col;
    let j = i + 1;
    while (
      j < len &&
      !/[\s#'"0-9a-zA-Z_]/.test(line[j])
    ) {
      j++;
    }
    const segLen = j - i;
    spans.push({ col: startCol, len: segLen, role: 'normal' });
    col += segLen;
    i = j;
  }

  return spans;
}

export function tokenColorAndAlpha(
  role: MinimapTokenRole,
  palette: MinimapPalette
): { color: string; alpha: number } {
  switch (role) {
    case 'keyword':
      return { color: palette.synKeyword, alpha: 0.78 };
    case 'string':
      return { color: palette.synString, alpha: 0.68 };
    case 'number':
      return { color: palette.synNumber, alpha: 0.72 };
    case 'comment':
      return { color: palette.synComment, alpha: 0.5 };
    case 'function':
      return { color: palette.synFunction, alpha: 0.8 };
    case 'class':
      return { color: palette.synClass, alpha: 0.82 };
    case 'heading1':
      return { color: palette.textPrimary, alpha: 0.92 };
    case 'heading2':
      return { color: palette.textPrimary, alpha: 0.76 };
    case 'heading3':
      return { color: palette.textSecondary, alpha: 0.72 };
    default:
      return { color: palette.textSecondary, alpha: 0.56 };
  }
}

export function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

export type MinimapOutputKind = 'error' | 'plot' | 'table' | 'stream' | 'none';

export interface CellOutputSummary {
  primaryKind: MinimapOutputKind;
  hasError: boolean;
  hasPlot: boolean;
  hasTable: boolean;
  hasText: boolean;
  badges: string[];
}

export function classifyCellOutputs(outputs: CellOutput[]): CellOutputSummary {
  let hasError = false;
  let hasPlot = false;
  let hasTable = false;
  let hasText = false;

  for (const out of outputs) {
    if (out.output_type === 'error') {
      hasError = true;
      continue;
    }
    const data = out.data;
    if (data && typeof data === 'object') {
      if (
        data['image/png'] ||
        data['image/jpeg'] ||
        data['image/svg+xml'] ||
        data['application/vnd.plotly.v1+json']
      ) {
        hasPlot = true;
      }
      const html = typeof data['text/html'] === 'string' ? data['text/html'] : '';
      if (html) {
        if (html.includes('Plotly.newPlot') || html.includes('plotly-graph-div')) {
          hasPlot = true;
        }
        if (html.includes('<table')) {
          hasTable = true;
        }
      }
      const preview = data['application/vnd.saturnolab.preview+json'];
      if (preview && typeof preview === 'object') {
        const kind = (preview as { kind?: string }).kind;
        if (kind === 'dataframe' || kind === 'series' || kind === 'table' || kind === 'mapping' || kind === 'sequence') {
          hasTable = true;
        }
      }
      if (!hasPlot && !hasTable && data['text/plain']) {
        hasText = true;
      }
    }
    if (out.output_type === 'stream' && out.text) {
      hasText = true;
    }
  }

  const badges: string[] = [];
  if (hasError) badges.push('Erro');
  if (hasPlot) badges.push('Gráfico');
  if (hasTable) badges.push('Tabela');
  if (hasText && !hasError && !hasPlot && !hasTable) badges.push('Saída');

  const primaryKind: MinimapOutputKind = hasError
    ? 'error'
    : hasPlot
      ? 'plot'
      : hasTable
        ? 'table'
        : hasText
          ? 'stream'
          : 'none';

  return { primaryKind, hasError, hasPlot, hasTable, hasText, badges };
}

export interface CellHoverPreview {
  cellId: string;
  cellNumber: number;
  totalCells: number;
  cellType: 'code' | 'markdown';
  executionCount: number | null;
  isRunning: boolean;
  heading?: string;
  lines: string[];
  outputSummary: CellOutputSummary;
  sectionCollapsed: boolean;
  outputCollapsed: boolean;
}

export function extractCellPreview(
  cell: NotebookCellData,
  cellIndex: number,
  totalCells: number
): CellHoverPreview {
  const rawLines = cell.source.replace(/\r\n/g, '\n').split('\n');
  let heading: string | undefined;
  const previewLines: string[] = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (cell.cell_type === 'markdown' && !heading) {
      const hm = trimmed.match(/^#{1,6}\s+(.+)$/);
      if (hm) {
        heading = hm[1].replace(/[*_`]/g, '').trim();
        continue;
      }
    }
    previewLines.push(line.length > 72 ? `${line.slice(0, 71)}…` : line);
    if (previewLines.length >= 4) break;
  }

  return {
    cellId: cell.id,
    cellNumber: cellIndex + 1,
    totalCells,
    cellType: cell.cell_type,
    executionCount: cell.execution_count,
    isRunning: Boolean(cell.isRunning),
    heading,
    lines: previewLines,
    outputSummary: classifyCellOutputs(cell.outputs),
    sectionCollapsed: Boolean(cell.sectionCollapsed),
    outputCollapsed: Boolean(cell.outputCollapsed),
  };
}

export function inferMinimapLanguage(cmLanguage?: string, filename?: string): MinimapLanguage {
  if (cmLanguage === 'python') return 'python';
  if (cmLanguage === 'markdown') return 'markdown';
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.py') || lower.endsWith('.pyw')) return 'python';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.json') || lower.endsWith('.ipynb')) return 'json';
  return 'text';
}
