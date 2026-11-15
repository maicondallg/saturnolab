export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

const CANDIDATE_DELIMITERS = [',', ';', '\t'] as const;

/**
 * Detect the most likely delimiter by checking consistency across the first few non-empty lines.
 */
export function detectCsvDelimiter(content: string): string {
  const sampleLines: string[] = [];
  let inQuotes = false;
  let lineStart = 0;

  for (let i = 0; i < content.length && sampleLines.length < 10; i++) {
    const ch = content[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === '\n' && !inQuotes) {
      const line = content.slice(lineStart, i).trim();
      if (line) sampleLines.push(line);
      lineStart = i + 1;
    }
  }
  if (sampleLines.length < 10 && lineStart < content.length) {
    const tail = content.slice(lineStart).trim();
    if (tail) sampleLines.push(tail);
  }

  if (sampleLines.length === 0) return ',';

  let bestDelimiter = ',';
  let bestScore = -1;

  for (const delim of CANDIDATE_DELIMITERS) {
    const counts = sampleLines.map((line) => countUnquotedDelimiter(line, delim));
    const first = counts[0];
    if (first === 0) continue;

    // Reward consistent column counts across sample lines.
    const consistent = counts.filter((c) => c === first).length;
    const score = consistent * 100 + first;
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delim;
    }
  }

  return bestDelimiter;
}

function countUnquotedDelimiter(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      count++;
    }
  }
  return count;
}

/**
 * Parse CSV/TSV text into headers and rows, handling quoted fields, escaped quotes, and newlines inside quotes.
 */
export function parseCsv(rawContent: string, forcedDelimiter?: string): ParsedCsv {
  // Strip UTF-8 BOM if present and normalize CRLF.
  const content = rawContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!content.trim()) {
    return { headers: [], rows: [], delimiter: forcedDelimiter || ',' };
  }

  const delimiter = forcedDelimiter || detectCsvDelimiter(content);
  const records: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      currentRow.push(currentField);
      currentField = '';
    } else if (ch === '\n') {
      currentRow.push(currentField);
      records.push(currentRow);
      currentRow = [];
      currentField = '';
    } else {
      currentField += ch;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    records.push(currentRow);
  }

  // Drop trailing completely empty line(s) caused by final newline.
  while (records.length > 0) {
    const last = records[records.length - 1];
    if (last.length === 1 && last[0] === '') {
      records.pop();
    } else {
      break;
    }
  }

  if (records.length === 0) {
    return { headers: [], rows: [], delimiter };
  }

  const maxCols = records.reduce((max, row) => Math.max(max, row.length), 0);
  const rawHeaders = records[0];
  const headers = Array.from({ length: maxCols }, (_, idx) => {
    const val = rawHeaders[idx] ?? '';
    return val || `Coluna ${idx + 1}`;
  });

  const rows = records.slice(1).map((row) => {
    if (row.length === maxCols) return row;
    return Array.from({ length: maxCols }, (_, idx) => row[idx] ?? '');
  });

  return { headers, rows, delimiter };
}

function escapeCsvField(value: string, delimiter: string): string {
  if (
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Serialize headers and rows back into CSV/TSV text using the given delimiter.
 */
export function serializeCsv(headers: string[], rows: string[][], delimiter: string): string {
  const lines = [headers, ...rows].map((row) =>
    row.map((cell) => escapeCsvField(cell, delimiter)).join(delimiter)
  );
  return lines.join('\n');
}
