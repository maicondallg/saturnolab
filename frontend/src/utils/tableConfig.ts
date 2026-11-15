import { TableOutputSettings } from '../types/notebook';

export const TABLE_OUTPUT_STORAGE_KEY = 'saturno_table_output';

export const DEFAULT_TABLE_OUTPUT_SETTINGS: TableOutputSettings = {
  wrap: 'nowrap',
  density: 'normal',
  font_size: 13,
  max_col_width: 280,
  align: 'auto',
  height: 'limited',
  sticky_headers: true,
  highlight_types: true,
  show_grid: true,
};

/** Normalize partial or untrusted table output settings into valid defaults. */
export function normalizeTableOutputSettings(
  raw?: Partial<TableOutputSettings> | null
): TableOutputSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_TABLE_OUTPUT_SETTINGS };
  }
  const wrap = raw.wrap === 'wrap' ? 'wrap' : 'nowrap';
  const density =
    raw.density === 'compact' || raw.density === 'comfortable' ? raw.density : 'normal';
  const fontSize =
    typeof raw.font_size === 'number' && Number.isFinite(raw.font_size)
      ? Math.max(11, Math.min(16, Math.round(raw.font_size)))
      : DEFAULT_TABLE_OUTPUT_SETTINGS.font_size;
  const maxColWidth =
    typeof raw.max_col_width === 'number' && Number.isFinite(raw.max_col_width)
      ? Math.max(0, Math.min(1200, Math.round(raw.max_col_width)))
      : DEFAULT_TABLE_OUTPUT_SETTINGS.max_col_width;
  const align =
    raw.align === 'left' || raw.align === 'right' ? raw.align : 'auto';
  const height = raw.height === 'full' ? 'full' : 'limited';

  return {
    wrap,
    density,
    font_size: fontSize,
    max_col_width: maxColWidth,
    align,
    height,
    sticky_headers: raw.sticky_headers ?? DEFAULT_TABLE_OUTPUT_SETTINGS.sticky_headers,
    highlight_types: raw.highlight_types ?? DEFAULT_TABLE_OUTPUT_SETTINGS.highlight_types,
    show_grid: raw.show_grid ?? DEFAULT_TABLE_OUTPUT_SETTINGS.show_grid,
  };
}

export function loadStoredTableOutputSettings(): TableOutputSettings {
  try {
    const raw = window.localStorage.getItem(TABLE_OUTPUT_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TABLE_OUTPUT_SETTINGS };
    return normalizeTableOutputSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TABLE_OUTPUT_SETTINGS };
  }
}

export function saveStoredTableOutputSettings(settings: TableOutputSettings): void {
  try {
    window.localStorage.setItem(TABLE_OUTPUT_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage unavailability
  }
}
