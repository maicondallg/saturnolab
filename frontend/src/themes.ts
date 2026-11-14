export type ThemeId =
  | 'jupyter_dark'
  | 'catppuccin'
  | 'graphite'
  | 'obsidian'
  | 'gruvbox'
  | 'nord'
  | 'paper'
  | 'solarized_light';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  isDark: boolean;
  bgPreview: string;
  accentPreview: string;
}

export const SATURNO_THEMES: ThemeMeta[] = [
  { id: 'jupyter_dark', label: 'JupyterLab Dark', isDark: true, bgPreview: '#212121', accentPreview: '#2196f3' },
  { id: 'catppuccin', label: 'Catppuccin Mocha', isDark: true, bgPreview: '#1e1e2e', accentPreview: '#cba6f7' },
  {
    id: 'graphite',
    label: 'Graphite (Escuro Neutro)',
    isDark: true,
    bgPreview: '#161618',
    accentPreview: '#d97736',
  },
  {
    id: 'obsidian',
    label: 'Obsidian (Preto Puro)',
    isDark: true,
    bgPreview: '#0b0b0c',
    accentPreview: '#a1a1aa',
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox Dark',
    isDark: true,
    bgPreview: '#1d2021',
    accentPreview: '#d65d0e',
  },
  {
    id: 'nord',
    label: 'Nord Slate',
    isDark: true,
    bgPreview: '#1e222a',
    accentPreview: '#81a1c1',
  },
  {
    id: 'paper',
    label: 'Jupyter Light',
    isDark: false,
    bgPreview: '#f5f5f6',
    accentPreview: '#c2591b',
  },
  {
    id: 'solarized_light',
    label: 'Warm Stone (Claro)',
    isDark: false,
    bgPreview: '#f3efe6',
    accentPreview: '#9a5b13',
  },
];

export function normalizeThemeId(raw?: string): ThemeId {
  if (!raw || raw === 'dark') return 'graphite';
  if (raw === 'light') return 'paper';
  const found = SATURNO_THEMES.find((t) => t.id === raw);
  return found ? found.id : 'graphite';
}

export function isThemeDark(raw?: string): boolean {
  const id = normalizeThemeId(raw);
  return SATURNO_THEMES.find((t) => t.id === id)?.isDark ?? true;
}
