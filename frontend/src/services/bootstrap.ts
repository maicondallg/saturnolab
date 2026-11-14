import { SaturnoConfig } from '../types/notebook';

// The bundled page includes appearance and workspace identity, never API keys.
export const bootstrapConfig = (window as Window & {
  __SATURNO_BOOTSTRAP__?: SaturnoConfig;
}).__SATURNO_BOOTSTRAP__;

export function persistAppearance(config: SaturnoConfig) {
  try {
    const values = {
      saturno_sidebar_width: config.sidebar_width,
      saturno_sidebar_pos: config.sidebar_position,
      saturno_nb_layout: config.notebook_layout,
      saturno_font_size: config.editor_font_size,
    };
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) localStorage.setItem(key, String(value));
    }
  } catch { /* Appearance still works when storage is unavailable. */ }
}
