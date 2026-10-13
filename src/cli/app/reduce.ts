import { screenOf } from '../browser/state.js';
import { reduceAdd } from './add.js';
import { reduceHome } from './home.js';
import { reduceLogs } from './logs.js';
import { reduceMailbox } from './mailbox.js';
import { reduceSignIn } from './sign-in.js';
import { emit, unknownView, type AppAction, type AppReduced, type AppState } from './state.js';

// The app's reducer (M2d): a resize, the stale-result rule, then the reducer of the view on
// screen. Pure - the controller runs the effects.

/** The first step: check who is signed in. */
export function startApp(state: AppState): AppReduced {
  return emit(state, { type: 'check-session' });
}

export function reduceApp(state: AppState, action: AppAction): AppReduced {
  if (action.type === 'resize') {
    const resized: AppState = { ...state, screen: screenOf(action.screen) };
    // The browser inside a mailbox has a screen of its own, which follows.
    return resized.view.kind === 'mailbox'
      ? reduceMailbox(resized, action)
      : { state: resized, effects: [] };
  }
  // A result of a request that was superseded meanwhile changes nothing. A browser result
  // carries no generation: the mailbox screen checks its browser token.
  if ('generation' in action && action.generation !== state.generation) {
    return { state, effects: [] };
  }
  const view = state.view;
  switch (view.kind) {
    case 'sign-in':
      return reduceSignIn(state, action);
    case 'home':
      return reduceHome(state, action);
    case 'mailbox':
      return reduceMailbox(state, action);
    case 'logs':
      return reduceLogs(state, action);
    case 'add':
      return reduceAdd(state, action);
    default:
      return unknownView(view);
  }
}
