import { FileEntry } from '../types/notebook';

export interface FileTypeVisual {
  category:
    | 'directory'
    | 'notebook'
    | 'python'
    | 'data'
    | 'json'
    | 'markdown'
    | 'shell'
    | 'config'
    | 'sql'
    | 'web'
    | 'text';
  color: string;
  badge?: string;
  cmLanguage: 'python' | 'markdown';
}

export function getFileVisual(
  nameOrEntry: string | { name: string; type?: string; extension?: string }
): FileTypeVisual {
  const isObj = typeof nameOrEntry !== 'string';
  const name = isObj ? nameOrEntry.name : nameOrEntry;
  const type = isObj ? nameOrEntry.type : undefined;

  if (type === 'directory') {
    return {
      category: 'directory',
      color: 'var(--sat-type-folder, #e5a93c)',
      cmLanguage: 'markdown',
    };
  }

  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? `.${lower.split('.').pop()}` : '';

  if (type === 'notebook' || ext === '.ipynb') {
    return {
      category: 'notebook',
      color: 'var(--sat-orange, #d97736)',
      badge: 'ipynb',
      cmLanguage: 'python',
    };
  }

  if (ext === '.py' || ext === '.pyi' || ext === '.pyw') {
    return {
      category: 'python',
      color: 'var(--sat-type-py, #3b82f6)',
      badge: 'py',
      cmLanguage: 'python',
    };
  }

  if (['.csv', '.tsv', '.parquet', '.xlsx', '.xls', '.feather'].includes(ext)) {
    return {
      category: 'data',
      color: 'var(--sat-type-data, #10b981)',
      badge: ext.slice(1),
      cmLanguage: 'markdown',
    };
  }

  if (['.json', '.jsonl', '.geojson'].includes(ext)) {
    return {
      category: 'json',
      color: 'var(--sat-type-json, #f59e0b)',
      badge: 'json',
      cmLanguage: 'python',
    };
  }

  if (['.md', '.markdown', '.rst'].includes(ext)) {
    return {
      category: 'markdown',
      color: 'var(--sat-type-md, #a855f7)',
      badge: 'md',
      cmLanguage: 'markdown',
    };
  }

  if (['.sh', '.bash', '.zsh'].includes(ext)) {
    return {
      category: 'shell',
      color: 'var(--sat-type-sh, #22c55e)',
      badge: 'sh',
      cmLanguage: 'python',
    };
  }

  if (['.yml', '.yaml', '.toml', '.ini', '.cfg', '.env'].includes(ext) || lower.startsWith('.env')) {
    return {
      category: 'config',
      color: 'var(--sat-type-cfg, #ec4899)',
      badge: ext ? ext.slice(1) : 'env',
      cmLanguage: 'python',
    };
  }

  if (['.sql', '.db', '.sqlite', '.sqlite3'].includes(ext)) {
    return {
      category: 'sql',
      color: 'var(--sat-type-sql, #06b6d4)',
      badge: 'sql',
      cmLanguage: 'python',
    };
  }

  if (['.js', '.ts', '.tsx', '.jsx', '.html', '.css'].includes(ext)) {
    return {
      category: 'web',
      color: 'var(--sat-type-web, #38bdf8)',
      badge: ext.slice(1),
      cmLanguage: 'python',
    };
  }

  return {
    category: 'text',
    color: 'var(--sat-text-secondary)',
    badge: ext ? ext.slice(1) : undefined,
    cmLanguage: 'markdown',
  };
}

export function formatModifiedShort(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');

  if (isToday) {
    return `${hh}:${mm}`;
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');

  if (date.getFullYear() === now.getFullYear()) {
    return `${day}/${month} ${hh}:${mm}`;
  }

  const yr = String(date.getFullYear()).slice(-2);
  return `${day}/${month}/${yr}`;
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatModifiedTooltip(entry: FileEntry): string {
  const parts = [entry.path];
  if (entry.modified) {
    const d = new Date(entry.modified);
    if (!Number.isNaN(d.getTime())) {
      parts.push(`Modificado: ${d.toLocaleString('pt-BR')}`);
    }
  }
  if (entry.type !== 'directory') {
    parts.push(`Tamanho: ${formatFileSize(entry.size)}`);
  }
  return parts.join('\n');
}

export interface FlatTreeNode {
  entry: FileEntry;
  depth: number;
}

export function flattenVisibleTree(
  items: FileEntry[],
  expandedFolders: Record<string, boolean>,
  folderChildren: Record<string, FileEntry[]> = {},
  depth = 0
): FlatTreeNode[] {
  const result: FlatTreeNode[] = [];
  for (const item of items) {
    result.push({ entry: item, depth });
    if (item.type === 'directory' && expandedFolders[item.path]) {
      const subItems = folderChildren[item.path] || item.children || [];
      if (subItems.length > 0) {
        result.push(
          ...flattenVisibleTree(subItems, expandedFolders, folderChildren, depth + 1)
        );
      }
    }
  }
  return result;
}

export function collectAllFolders(
  items: FileEntry[],
  folderChildren: Record<string, FileEntry[]> = {},
  excludePaths: Set<string> = new Set()
): { path: string; label: string; depth: number }[] {
  const result: { path: string; label: string; depth: number }[] = [
    { path: '', label: '/ (Raiz do Workspace)', depth: 0 },
  ];

  const walk = (nodes: FileEntry[], depth: number) => {
    for (const node of nodes) {
      if (node.type === 'directory') {
        if (excludePaths.has(node.path)) continue;
        result.push({
          path: node.path,
          label: `${'  '.repeat(depth)}📁 ${node.path}`,
          depth,
        });
        const subItems = folderChildren[node.path] || node.children || [];
        if (subItems.length > 0) {
          walk(subItems, depth + 1);
        }
      }
    }
  };

  walk(items, 1);
  return result;
}
