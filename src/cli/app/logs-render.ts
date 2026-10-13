import { columns, type HelpItem } from '../browser/layout.js';
import { fit } from '../browser/width.js';
import { sanitize } from '../log-text.js';
import { logRows } from './logs.js';
import { failureLines, type MailboxBody } from './mailbox-render.js';
import { asciiText, type LogsView, type LogsWindow } from './state.js';

// The logs screen (M2d-5) as plain-text pieces for render.ts: header, body, what the status
// line says, key help. The body is the page of `mm logs` with its end on the last line: the
// newest lines are the ones on screen, older ones scroll in from above. Pure. The lines arrive
// sanitised and in ASCII (the controller sees to that) and are wrapped as they are; a row that
// is drawn goes through sanitize() and asciiText() once more and is fitted to the width, so a
// frame is exact whatever the state holds. A log folder that can't be read shows why, in the
// body.

const WINDOW_TEXT: Record<LogsWindow, string> = { '24h': '24 h', '7d': '7 days', '30d': '30 days' };

/** `Esc back` and `q quit` are the last to go; then the windows and filters, then the rest. */
const HELP: readonly HelpItem[] = [
  { text: 'Up/Down scroll', rank: 7 },
  { text: '1 24 h', rank: 2 },
  { text: '2 7 days', rank: 3 },
  { text: '3 30 days', rank: 4 },
  { text: 's security', rank: 5 },
  { text: 'w warnings', rank: 6 },
  { text: 'r read again', rank: 8 },
  { text: 'Esc back', rank: 0 },
  { text: 'q quit', rank: 1 },
];
/** Only the reason is shown: nothing scrolls, and reading again is the key that helps. */
const HELP_FAILED: readonly HelpItem[] = [
  { text: '1 24 h', rank: 3 },
  { text: '2 7 days', rank: 4 },
  { text: '3 30 days', rank: 5 },
  { text: 's security', rank: 6 },
  { text: 'w warnings', rank: 7 },
  { text: 'r read again', rank: 2 },
  { text: 'Esc back', rank: 0 },
  { text: 'q quit', rank: 1 },
];

function padded(lines: string[], height: number, cols: number): string[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push(fit('', cols));
  return out;
}

/** `Mail Manager - Logs`, and on the right what is shown: the window, then the filters. */
export function logsHeader(view: LogsView, cols: number): string {
  const filters = `${view.securityOnly ? ' - security' : ''}${view.warnOnly ? ' - warnings' : ''}`;
  return columns('Mail Manager - Logs', `${WINDOW_TEXT[view.window]}${filters}`, cols);
}

export function logsBody(view: LogsView, height: number, cols: number): MailboxBody {
  if (view.mode === 'failed') {
    return {
      lines: padded(failureLines(view.failure ?? '', height, cols), height, cols),
      cursorLine: null,
    };
  }
  const rows = logRows(view.lines, cols);
  // The page ends on the last body line; a short one starts at the top instead.
  const last = Math.max(0, rows.length - height);
  const scroll = Math.min(Math.max(0, view.scroll), last);
  const window = rows.slice(last - scroll, last - scroll + height);
  return {
    lines: padded(window, height, cols).map((row) => fit(asciiText(sanitize(row)), cols)),
    cursorLine: null,
  };
}

/** What the screen is waiting for, or null. */
export function logsBusy(view: LogsView): string | null {
  return view.mode === 'reading' ? 'Reading the logs...' : null;
}

export function logsHelp(view: LogsView): readonly HelpItem[] {
  return view.mode === 'failed' ? HELP_FAILED : HELP;
}
