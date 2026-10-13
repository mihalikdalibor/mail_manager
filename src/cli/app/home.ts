import { bodyHeight } from '../browser/state.js';
import { addView } from './add.js';
import { logsView } from './logs.js';
import {
  HOME_ACTIONS,
  emit,
  isLetter,
  mailboxView,
  pickView,
  tooSmall,
  type AppAction,
  type AppKey,
  type AppReduced,
  type AppState,
  type HomeView,
} from './state.js';

// Home (M2d-1) as a pure reducer: the signed-in user's mailboxes, then "+ Add a mailbox",
// "Logs" and "Log out". Enter on a mailbox opens its screen (M2d-2, mailbox.ts), on "+ Add a
// mailbox" the add screen (M2d-4, add.ts) and on "Logs" the logs screen (M2d-5, logs.ts); each
// keeps this view to come back to. A mailbox that was just added gets the cursor when the list
// arrives again, and "Added <address>." is said until the next key.

function same(state: AppState): AppReduced {
  return { state, effects: [] };
}

function listKey(state: AppState, view: HomeView, key: AppKey): AppReduced {
  // Only "window too small" is shown: quit is the one key that acts.
  if (tooSmall(state.screen)) {
    return isLetter(key, 'q') ? { state, effects: [{ type: 'quit' }] } : same(state);
  }
  const mailboxes = view.mailboxes ?? [];
  const last = mailboxes.length + HOME_ACTIONS.length - 1;
  // A key clears the message (and "Added ..."); while the list couldn't be loaded, that one
  // stays.
  const v: HomeView = { ...view, message: view.loadFailed ? 'load-failed' : null, added: null };
  const moved = (cursor: number): AppReduced =>
    same({ ...state, view: { ...v, cursor: Math.min(Math.max(0, cursor), last) } });
  const page = bodyHeight(state.screen);
  switch (key.type) {
    case 'up':
      return moved(v.cursor - 1);
    case 'down':
      return moved(v.cursor + 1);
    case 'pageup':
      return moved(v.cursor - page);
    case 'pagedown':
      return moved(v.cursor + page);
    case 'enter': {
      const mailbox = mailboxes[v.cursor];
      if (mailbox !== undefined) {
        // The generation seeds the browser tokens: never one an earlier mailbox visit used.
        return emit(
          { ...state, view: mailboxView(mailbox, v, state.generation) },
          { type: 'open-mailbox', accountId: mailbox.id },
        );
      }
      const action = HOME_ACTIONS[v.cursor - mailboxes.length];
      if (action === undefined) return same({ ...state, view: v });
      if (action === 'log-out') {
        return emit(
          { ...state, view: { ...v, mode: 'signing-out', message: null } },
          { type: 'sign-out' },
        );
      }
      if (action === 'logs') {
        return emit(
          { ...state, view: logsView(v) },
          { type: 'read-logs', window: '24h', securityOnly: false, warnOnly: false },
        );
      }
      // Nothing is asked for yet: the first step is a field.
      return same({ ...state, view: addView(v, state.addProblem) });
    }
    case 'escape':
    case 'left':
    case 'backspace':
      // Back to the sign-in page, still signed in. The new generation drops a list in flight.
      return same({ ...state, generation: state.generation + 1, view: pickView() });
    case 'char':
      if (isLetter(key, 'q')) return { state: { ...state, view: v }, effects: [{ type: 'quit' }] };
      if (isLetter(key, 'r') && view.loadFailed) {
        return emit(
          { ...state, view: { ...v, mailboxes: null, loadFailed: false, message: null } },
          { type: 'load-mailboxes' },
        );
      }
      return same({ ...state, view: v });
    default:
      return same({ ...state, view: v });
  }
}

/** One step of Home; a state showing another view comes back unchanged. */
export function reduceHome(state: AppState, action: AppAction): AppReduced {
  const view = state.view;
  if (view.kind !== 'home') return same(state);
  switch (action.type) {
    case 'key':
      return view.mode === 'list' ? listKey(state, view, action.key) : same(state);
    case 'mailboxes': {
      // The mailbox that was just added, when it is in the list; otherwise the first row.
      const focus = action.rows.findIndex((row) => row.id === view.focusId);
      return same({
        ...state,
        view: {
          ...view,
          mailboxes: action.rows,
          loadFailed: false,
          cursor: Math.max(0, focus),
          message: null,
          focusId: null,
        },
      });
    }
    case 'mailboxes-failed':
      return same({ ...state, view: { ...view, loadFailed: true, message: 'load-failed' } });
    case 'session-ended':
      return same({
        ...state,
        current: null,
        remembered: action.remembered,
        view: pickView('session-ended'),
      });
    case 'signed-out':
      if (view.mode !== 'signing-out') return same(state);
      return same({ ...state, current: null, remembered: action.remembered, view: pickView() });
    default:
      return same(state);
  }
}
