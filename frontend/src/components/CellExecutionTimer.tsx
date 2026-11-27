import React, { useEffect, useState } from 'react';
import { CellExecutionStatus } from '../types/notebook';
import {
  formatCellDuration,
  formatCellExecutionTooltip,
} from '../utils/executionTime';

interface Props {
  isRunning?: boolean;
  executionQueued?: boolean;
  executionStartedAt?: number | null;
  executionDurationMs?: number | null;
  executionStatus?: CellExecutionStatus | null;
  executionFinishedAt?: string | null;
}

export const CellExecutionTimer: React.FC<Props> = React.memo(
  ({
    isRunning,
    executionQueued,
    executionStartedAt,
    executionDurationMs,
    executionStatus,
    executionFinishedAt,
  }) => {
    const isActivelyRunning = Boolean(
      isRunning && !executionQueued && executionStartedAt != null
    );
    const [liveElapsedMs, setLiveElapsedMs] = useState<number | null>(() =>
      isActivelyRunning && executionStartedAt != null
        ? Math.max(0, Date.now() - executionStartedAt)
        : null
    );

    useEffect(() => {
      if (!isActivelyRunning || executionStartedAt == null) {
        setLiveElapsedMs(null);
        return;
      }

      let cancelled = false;
      let timerId: number | null = null;

      const tick = () => {
        if (cancelled) return;
        const elapsed = Math.max(0, Date.now() - executionStartedAt);
        setLiveElapsedMs(elapsed);
        const delay = elapsed < 60_000 ? 100 : 1000 - (elapsed % 1000 || 1000);
        timerId = window.setTimeout(tick, Math.max(50, delay));
      };

      tick();
      return () => {
        cancelled = true;
        if (timerId !== null) window.clearTimeout(timerId);
      };
    }, [isActivelyRunning, executionStartedAt]);

    if (isRunning && executionQueued) {
      return (
        <span
          data-cell-exec-time="queued"
          className="cell-exec-time is-queued"
          title={formatCellExecutionTooltip({ queued: true })}
        >
          fila
        </span>
      );
    }

    if (isActivelyRunning && executionStartedAt != null) {
      const elapsed =
        liveElapsedMs !== null
          ? liveElapsedMs
          : Math.max(0, Date.now() - executionStartedAt);
      return (
        <span
          data-cell-exec-time="running"
          className="cell-exec-time is-running"
          title={formatCellExecutionTooltip({ running: true, elapsedMs: elapsed })}
        >
          {formatCellDuration(elapsed, { live: true })}
        </span>
      );
    }

    if (!isRunning && typeof executionDurationMs === 'number') {
      const isError = executionStatus === 'error';
      return (
        <span
          data-cell-exec-time={isError ? 'error' : 'done'}
          className={`cell-exec-time ${isError ? 'is-error' : 'is-done'}`}
          title={formatCellExecutionTooltip({
            durationMs: executionDurationMs,
            status: executionStatus,
            finishedAt: executionFinishedAt,
          })}
        >
          {formatCellDuration(executionDurationMs, { live: false })}
        </span>
      );
    }

    return null;
  }
);
