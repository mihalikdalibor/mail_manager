import { wrap } from '../browser/layout.js';
import { bodyHeight } from '../browser/state.js';
import {
  backToHome,
  emit,
  isLetter,
  tooSmall,
  type AppAction,
  type AppKey,
  type AppReduced,
  type AppState,
  type HomeView,
  type LogsView,
  type LogsWindow,
} from './state.js';

// The logs screen (M2d-5) as a pure reducer: what `mm logs` prints as one page that scrolls.
// The newest line is at the bottom, so the page opens there and Up goes back in time. A key
// that changes what is asked for - the window, a filter, `r` - reads again as a new request:
// the lines on screen stay until the new ones arrive, and an answer to an older request is
// dropped by its generation (reduce.ts). Nothing here reads a file: the controller does, and
// hands over lines that are already sanitised. Esc goes back to Home as it was (backToHome in
// state.ts: a mailbox list that was still on its way when the logs were opened is asked for
// again).

/** Columns a wrapped line continues at: under the command, past the time. */
const CONTINUATION = 10;

/** The keys that choose how far back to look. */
const WINDOW_KEYS: ReadonlyMap<string, LogsWindow> = new Map([
  ['1', '24h'],
  ['2', '7d'],
  ['3', '30d'],
]);

function same(state: AppState): AppReduced {
  return { state, effects: [] };
}

function shown(state: AppState, view: LogsView): AppState {
  return { ...state, view };
}

/** The logs screen as Enter on Home's "Logs" opens it: the last 24 hours, nothing read yet. */
export function logsView(home: HomeView): LogsView {
  return {
    kind: 'logs',
    home,
    mode: 'reading',
    window: '24h',
    securityOnly: false,
    warnOnly: false,
    lines: [],
    failure: null,
    scroll: 0,
  };
}

/**
 * The lines as rows of at most `cols` columns. A longer line is cut at the last space that
 * fits and goes on, wrapped, on rows indented 10 columns; one without a space to cut at (a
 * single long word) is cut at the width.
 */
export function logRows(lines: readonly string[], cols: number): string[] {
  const width = Math.max(1, Math.floor(cols));
  // Narrower than the indent (no screen the app draws on is): the rows go on without it.
  const indent = width > CONTINUATION ? ' '.repeat(CONTINUATION) : '';
  const rows: string[] = [];
  for (const line of lines) {
    if (line.length <= width) {
      rows.push(line);
      continue;
    }
    const space = line.lastIndexOf(' ', width);
    // A space that early would leave the row to the time alone.
    const cut = space < CONTINUATION ? width : space;
    rows.push(line.slice(0, cut).trimEnd());
    for (const part of wrap(line.slice(cut), width - indent.length)) rows.push(`${indent}${part}`);
  }
  return rows;
}

/** One more read for what the view asks for: a new request, from the bottom of its page. */
function read(state: AppState, view: LogsView): AppReduced {
  return emit(shown(state, { ...view, mode: 'reading', failure: null, scroll: 0 }), {
    type: 'read-logs',
    window: view.window,
    securityOnly: view.securityOnly,
    warnOnly: view.warnOnly,
  });
}

/** `by` rows towards the older lines (or back), kept inside the page. */
function scrolled(state: AppState, view: LogsView, by: number): AppReduced {
  const rows = logRows(view.lines, state.screen.cols).length;
  const last = Math.max(0, rows - bodyHeight(state.screen));
  const scroll = Math.min(Math.max(0, view.scroll + by), last);
  return scroll === view.scroll ? same(state) : same(shown(state, { ...view, scroll }));
}

function onKey(state: AppState, view: LogsView, key: AppKey): AppReduced {
  if (isLetter(key, 'q')) return { state, effects: [{ type: 'quit' }] };
  // Only "window too small" is shown: quit is the one key that acts.
  if (tooSmall(state.screen)) return same(state);
  const page = bodyHeight(state.screen);
  switch (key.type) {
    case 'escape':
    case 'left':
    case 'backspace':
      // Home as it was. The new generation drops a read still under way.
      return backToHome(state, view.home);
    case 'up':
      return scrolled(state, view, 1);
    case 'down':
      return scrolled(state, view, -1);
    case 'pageup':
      return scrolled(state, view, page);
    case 'pagedown':
      return scrolled(state, view, -page);
    case 'char': {
      const window = WINDOW_KEYS.get(key.text);
      if (window !== undefined) return read(state, { ...view, window });
      if (isLetter(key, 's')) return read(state, { ...view, securityOnly: !view.securityOnly });
      if (isLetter(key, 'w')) return read(state, { ...view, warnOnly: !view.warnOnly });
      return isLetter(key, 'r') ? read(state, view) : same(state);
    }
    default:
      return same(state);
  }
}

/** One step of the logs screen; a state showing another view comes back unchanged. */
export function reduceLogs(state: AppState, action: AppAction): AppReduced {
  const view = state.view;
  if (view.kind !== 'logs') return same(state);
  switch (action.type) {
    case 'key':
      return onKey(state, view, action.key);
    case 'logs-read':
      // reduce.ts has dropped the answer to an older request: this one is waited for.
      if (view.mode !== 'reading') return same(state);
      return same(shown(state, { ...view, mode: 'shown', lines: action.lines, scroll: 0 }));
    case 'logs-failed':
      if (view.mode !== 'reading') return same(state);
      return same(
        shown(state, { ...view, mode: 'failed', lines: [], failure: action.text, scroll: 0 }),
      );
    default:
      return same(state);
  }
}
