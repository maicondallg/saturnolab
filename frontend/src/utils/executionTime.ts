import { CellExecutionStatus } from '../types/notebook';

export function formatCellDuration(
  ms: number,
  options?: { live?: boolean }
): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return options?.live ? '0.0s' : '0ms';
  }
  const safeMs = Math.max(0, ms);

  if (options?.live) {
    if (safeMs < 59_950) {
      return `${(safeMs / 1000).toFixed(1)}s`;
    }
    const totalSec = Math.floor(safeMs / 1000);
    if (totalSec < 3600) {
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return `${m}m ${String(s).padStart(2, '0')}s`;
    }
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h ${String(m).padStart(2, '0')}m`;
  }

  const roundedMs = Math.round(safeMs);
  if (roundedMs < 1) {
    return '<1ms';
  }
  if (roundedMs < 1000) {
    return `${roundedMs}ms`;
  }
  if (safeMs < 9_995) {
    return `${(safeMs / 1000).toFixed(2)}s`;
  }
  if (safeMs < 59_950) {
    return `${(safeMs / 1000).toFixed(1)}s`;
  }
  const totalSec = Math.round(safeMs / 1000);
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function formatDetailedDuration(
  ms: number,
  options?: { live?: boolean }
): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return options?.live ? '0.0s' : '0 ms';
  }
  const safeMs = Math.max(0, ms);

  if (options?.live) {
    if (safeMs < 60_000) {
      return `${(safeMs / 1000).toFixed(1)}s`;
    }
    const totalSec = Math.floor(safeMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) {
      return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
    }
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }

  const roundedMs = Math.round(safeMs);
  if (roundedMs < 1) {
    return '< 1 ms';
  }
  if (roundedMs < 1000) {
    return `${roundedMs} ms`;
  }
  if (safeMs < 60_000) {
    return `${(safeMs / 1000).toFixed(3)}s`;
  }
  const totalSec = Math.floor(safeMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  }
  const remSec = (safeMs - m * 60_000) / 1000;
  return `${m}m ${remSec.toFixed(1).padStart(4, '0')}s`;
}

export function formatExecutionClockTime(iso?: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatCellExecutionTooltip(params: {
  queued?: boolean;
  running?: boolean;
  elapsedMs?: number | null;
  durationMs?: number | null;
  status?: CellExecutionStatus | null;
  finishedAt?: string | null;
}): string {
  if (params.queued) {
    return 'Aguardando execução na fila do kernel';
  }
  if (params.running && typeof params.elapsedMs === 'number') {
    return `Executando há ${formatDetailedDuration(params.elapsedMs, { live: true })}`;
  }
  if (typeof params.durationMs === 'number') {
    const detailed = formatDetailedDuration(params.durationMs);
    const clock = formatExecutionClockTime(params.finishedAt);
    const prefix = params.status === 'error' ? 'Falhou após' : 'Executada em';
    return clock ? `${prefix} ${detailed} · às ${clock}` : `${prefix} ${detailed}`;
  }
  return '';
}
