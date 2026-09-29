import type { LogLevel } from '../config.js';
import { LEVEL_ORDER, type LogEvent, type LogKind } from './events.js';
import { renderEvent, type LogRecord, type RunContext } from './record.js';

/** Where core and shells send events. Core never prints; the shell picks the sink. */
export interface EventLog {
  emit(event: LogEvent): void;
}

/** Security lines are always written; app lines only at or above the run's level. */
export function passesLevel(kind: LogKind, level: LogLevel, threshold: LogLevel): boolean {
  return kind === 'security' || LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}

/** Builds and emits; any error is swallowed — logging never breaks a command. */
export function safeEmit(log: EventLog, build: () => LogEvent): void {
  try {
    log.emit(build());
  } catch {
    // Deliberately ignored: a failed log line must not change the command's result.
  }
}

export class NullEventLog implements EventLog {
  emit(): void {
    // Nothing is recorded (default for buildProgram, so tests never write files).
  }
}

/** Keeps records and lines in memory (tests). Same rendering and threshold as the file log. */
export class MemoryEventLog implements EventLog {
  readonly records: LogRecord[] = [];
  readonly lines: string[] = [];

  constructor(private readonly ctx: RunContext) {}

  emit(event: LogEvent): void {
    const rendered = renderEvent(event, this.ctx);
    if (rendered === null) return;
    if (!passesLevel(rendered.kind, rendered.record.level, this.ctx.level)) return;
    this.records.push(rendered.record);
    this.lines.push(rendered.line);
  }
}
