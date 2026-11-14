import { marked, Tokens } from 'marked';
import { NotebookCellData } from '../types/notebook';

// Cell objects retain their identity when another cell changes. Weak keys let
// closed notebooks be collected without retaining their Markdown sources.
const headingCache = new WeakMap<NotebookCellData, { source: string; headings: { ordinal: number; level: number; title: string }[] }>();

export function notebookOutline(cells: NotebookCellData[]) {
  return cells.flatMap((cell, index) => {
    if (cell.cell_type !== 'markdown') return [];
    let cached = headingCache.get(cell);
    if (!cached || cached.source !== cell.source) {
      cached = {
        source: cell.source,
        headings: marked.lexer(cell.source)
          .filter((token): token is Tokens.Heading => token.type === 'heading')
          .map((token, ordinal) => ({
            ordinal, level: token.depth, title: token.text.replace(/[*_`]/g, ''),
          })),
      };
      headingCache.set(cell, cached);
    }
    return cached.headings.map(heading => ({ ...heading, cellId: cell.id, index }));
  });
}

export function hiddenSectionCells(cells: NotebookCellData[]) {
  if (!cells.some(cell => cell.sectionCollapsed)) return new Set<string>();
  const headings = notebookOutline(cells);
  const hidden = new Set<string>();
  for (const heading of headings) {
    if (!cells[heading.index].sectionCollapsed || heading.ordinal !== 0) continue;
    const end = headings.find(h => h.index > heading.index && h.level <= heading.level)?.index ?? cells.length;
    for (let i = heading.index + 1; i < end; i++) hidden.add(cells[i].id);
  }
  return hidden;
}
