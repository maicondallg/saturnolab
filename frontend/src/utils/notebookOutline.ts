import { marked, Tokens } from 'marked';
import { NotebookCellData } from '../types/notebook';

export function notebookOutline(cells: NotebookCellData[]) {
  return cells.flatMap((cell, index) => cell.cell_type !== 'markdown' ? [] :
    marked.lexer(cell.source).filter((token): token is Tokens.Heading => token.type === 'heading').map((token, ordinal) => ({
      cellId: cell.id, index, ordinal, level: token.depth as number,
      title: token.text.replace(/[*_`]/g, ''),
    })));
}

export function hiddenSectionCells(cells: NotebookCellData[]) {
  const headings = notebookOutline(cells);
  const hidden = new Set<string>();
  for (const heading of headings) {
    if (!cells[heading.index].sectionCollapsed || heading.ordinal !== 0) continue;
    const end = headings.find(h => h.index > heading.index && h.level <= heading.level)?.index ?? cells.length;
    for (let i = heading.index + 1; i < end; i++) hidden.add(cells[i].id);
  }
  return hidden;
}
