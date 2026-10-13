import { bodyHeight } from '../browser/state.js';
import { sanitize } from '../log-text.js';
import {
  MAX_EMAIL_CHARS,
  MAX_PASSWORD_CHARS,
  emit,
  erased,
  homeView,
  isLetter,
  knownUsers,
  tooSmall,
  typed,
  type AppAction,
  type AppKey,
  type AppMessage,
  type AppReduced,
  type AppState,
  type SignInForm,
  type SignInView,
} from './state.js';

// The sign-in page (M2d-1) as a pure reducer. Rows of its list: the known users (the signed-in
// one first, then the remembered addresses) and one last row, "Sign in as another user". The
// form takes an e-mail and a password; choosing someone else while a user is signed in asks
// first and signs that user out before the form opens.

const FAILURE_MESSAGE: Record<
  Extract<AppAction, { type: 'sign-in-failed' }>['reason'],
  AppMessage
> = {
  'invalid-credentials': 'wrong-credentials',
  unreachable: 'unreachable',
  unknown: 'sign-in-failed',
};

function same(state: AppState): AppReduced {
  return { state, effects: [] };
}

function quit(state: AppState): AppReduced {
  return { state, effects: [{ type: 'quit' }] };
}

/** The view put in place, its cursor inside the rows (they change with the known users). */
function shown(state: AppState, view: SignInView): AppState {
  const cursor = Math.min(Math.max(0, view.cursor), knownUsers(state).length);
  return { ...state, view: cursor === view.cursor ? view : { ...view, cursor } };
}

function emptyForm(): SignInForm {
  return { email: '', fixedEmail: false, password: '', field: 'email' };
}

function pickKey(state: AppState, view: SignInView, key: AppKey): AppReduced {
  const users = knownUsers(state);
  const v: SignInView = view.message === null ? view : { ...view, message: null };
  const user = users[v.cursor];
  const page = bodyHeight(state.screen);
  switch (key.type) {
    case 'up':
      return same(shown(state, { ...v, cursor: v.cursor - 1 }));
    case 'down':
      return same(shown(state, { ...v, cursor: v.cursor + 1 }));
    case 'pageup':
      return same(shown(state, { ...v, cursor: v.cursor - page }));
    case 'pagedown':
      return same(shown(state, { ...v, cursor: v.cursor + page }));
    case 'enter': {
      if (user?.signedIn === true) {
        return emit({ ...state, view: homeView() }, { type: 'load-mailboxes' });
      }
      const form: SignInForm =
        user === undefined
          ? emptyForm()
          : { email: user.email, fixedEmail: true, password: '', field: 'password' };
      // Somebody is signed in: that session is ended first, after asking.
      const mode = state.current === null ? 'form' : 'confirm-switch';
      return same(shown(state, { ...v, mode, form }));
    }
    case 'escape':
      return quit(shown(state, v));
    case 'char':
      if (isLetter(key, 'q')) return quit(shown(state, v));
      if (isLetter(key, 'f') && user !== undefined) {
        return same(
          shown(
            state,
            user.signedIn
              ? { ...v, message: 'forget-signed-in' }
              : { ...v, mode: 'confirm-forget' },
          ),
        );
      }
      return same(shown(state, v));
    default:
      return same(shown(state, v));
  }
}

function formKey(state: AppState, view: SignInView, form: SignInForm, key: AppKey): AppReduced {
  const v: SignInView = view.message === null ? view : { ...view, message: null };
  const withForm = (next: SignInForm, message: AppMessage | null = null): AppReduced =>
    same({ ...state, view: { ...v, form: next, message } });
  // The field being typed into; a fixed e-mail can't be changed.
  const edit = (change: (value: string) => string): AppReduced => {
    if (form.field === 'password') return withForm({ ...form, password: change(form.password) });
    return form.fixedEmail ? withForm(form) : withForm({ ...form, email: change(form.email) });
  };
  switch (key.type) {
    case 'char': {
      const { text } = key;
      if (form.field === 'password') return edit((value) => typed(value, text, MAX_PASSWORD_CHARS));
      // Text that couldn't be shown is not taken into the e-mail.
      if (sanitize(text) !== text) return withForm(form);
      return edit((value) => typed(value, text, MAX_EMAIL_CHARS));
    }
    case 'backspace':
      return edit(erased);
    case 'clear':
      return edit(() => '');
    case 'tab':
    case 'up':
    case 'down':
      return withForm({
        ...form,
        field: form.field === 'email' || form.fixedEmail ? 'password' : 'email',
      });
    case 'enter': {
      if (form.email.trim() === '') return withForm({ ...form, field: 'email' }, 'email-required');
      if (form.field === 'email') return withForm({ ...form, field: 'password' });
      if (form.password === '') return withForm(form, 'password-required');
      // The password leaves the state here: it travels in the effect only.
      return emit(
        { ...state, view: { ...v, mode: 'submitting', form: { ...form, password: '' } } },
        { type: 'sign-in', email: form.email.trim(), password: form.password },
      );
    }
    case 'escape':
      return same(shown(state, { ...v, mode: 'pick', form: null }));
    default:
      return withForm(form);
  }
}

function onKey(state: AppState, view: SignInView, key: AppKey): AppReduced {
  // Only "window too small" is shown: a pending question is still answered, a list can be
  // quit, and nothing is typed into a form that isn't on screen.
  const small = tooSmall(state.screen);
  switch (view.mode) {
    case 'checking':
    case 'submitting':
    case 'signing-out':
      return same(state);
    case 'check-failed':
      if (isLetter(key, 'q') || (!small && key.type === 'escape')) return quit(state);
      if (!small && isLetter(key, 'r')) {
        return emit(
          { ...state, view: { ...view, mode: 'checking', message: null } },
          { type: 'check-session' },
        );
      }
      return same(state);
    case 'pick':
      if (small) return isLetter(key, 'q') ? quit(state) : same(state);
      return pickKey(state, view, key);
    case 'confirm-switch':
      return isLetter(key, 'y')
        ? emit({ ...state, view: { ...view, mode: 'signing-out' } }, { type: 'sign-out' })
        : same(shown(state, { ...view, mode: 'pick', form: null }));
    case 'confirm-forget': {
      const picked = shown(state, { ...view, mode: 'pick' });
      const user = knownUsers(state)[view.cursor];
      return isLetter(key, 'y') && user !== undefined && !user.signedIn
        ? { state: picked, effects: [{ type: 'forget', email: user.email }] }
        : same(picked);
    }
    case 'form':
      if (small || view.form === null) return same(state);
      return formKey(state, view, view.form, key);
  }
}

/** One step of the sign-in page; a state showing another view comes back unchanged. */
export function reduceSignIn(state: AppState, action: AppAction): AppReduced {
  const view = state.view;
  if (view.kind !== 'sign-in') return same(state);
  switch (action.type) {
    case 'key':
      return onKey(state, view, action.key);
    case 'session': {
      if (view.mode !== 'checking') return same(state);
      const next: AppState = { ...state, current: action.user, remembered: action.remembered };
      // Nobody to choose from: straight to the form.
      return knownUsers(next).length === 0
        ? same({ ...next, view: { ...view, mode: 'form', cursor: 0, form: emptyForm() } })
        : same({ ...next, view: { ...view, mode: 'pick', cursor: 0, form: null } });
    }
    case 'session-failed': {
      if (view.mode !== 'checking') return same(state);
      const next: AppState = { ...state, current: null, remembered: action.remembered };
      return same(shown(next, { ...view, mode: 'check-failed', message: 'unreachable' }));
    }
    case 'signed-in':
      if (view.mode !== 'submitting') return same(state);
      return emit(
        { ...state, current: action.user, remembered: action.remembered, view: homeView() },
        { type: 'load-mailboxes' },
      );
    case 'sign-in-failed': {
      if (view.mode !== 'submitting') return same(state);
      const message = FAILURE_MESSAGE[action.reason];
      return view.form === null
        ? same(shown(state, { ...view, mode: 'pick', message }))
        : same({
            ...state,
            view: { ...view, mode: 'form', form: { ...view.form, field: 'password' }, message },
          });
    }
    case 'signed-out': {
      if (view.mode !== 'signing-out') return same(state);
      const next: AppState = { ...state, current: null, remembered: action.remembered };
      // The form that waited for the sign-out opens now.
      return same(shown(next, { ...view, mode: view.form === null ? 'pick' : 'form' }));
    }
    case 'remembered':
      return same(shown({ ...state, remembered: action.emails }, view));
    default:
      return same(state);
  }
}
