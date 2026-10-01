import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CommandFinishEvent,
  CommandOutcome,
  CommandStartEvent,
  UnexpectedErrorEvent,
} from './events.js';
import {
  CLASS_RE,
  CMD_STRIP,
  CODE_RE,
  FRAME_STRIP,
  MAX_CMD_CHARS,
  MAX_FRAME_BYTES,
  MAX_FRAMES,
  MAX_OPT_CHARS,
  MAX_OPTS,
  OPT_NAME_RE,
  OS_STRIP,
  PROVIDER_RE,
  UUID_RE,
  VERSION_STRIP,
} from './event-schemas.js';

// Event builders cap and allowlist every field: whatever the caller passes, only short,
// value-free text reaches a log line (no option values, messages, home paths).

// The shapes V8 prints: `fn`, `Obj.method`, `Object.<anonymous>`, `async fn`, `new Foo`,
// `obj.fn [as alias]`. Anything else (spaces inside, computed names) could be data → `<fn>`.
const FN_RE = /^(?:async |new )?[A-Za-z0-9_$.<>]{1,80}(?: \[as [A-Za-z0-9_$]{1,40}\])?$/;
const FRAME_RE = /^\s+at (.+)$/;
const CALL_RE = /^(.*?) \((.*)\)$/;
const LINE_COL_RE = /(:\d+(?::\d+)?)$/;
const NODE_LOCATION_RE = /^node:[a-z0-9_/]{1,80}(?::\d+){0,2}$/;

export interface Runtime {
  ver: string;
  node: string;
  os: string;
}

/** Reads a property that may be a throwing getter. */
function safeGet<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function clean(value: string, allowed: RegExp, max: number): string {
  return value.replace(allowed, '').slice(0, max);
}

function cleanCmd(cmd: string): string {
  return clean(cmd, CMD_STRIP, MAX_CMD_CHARS);
}

function cleanVersion(value: string): string {
  return clean(value, VERSION_STRIP, 40);
}

export function commandStart(
  cmd: string,
  optionNames: readonly string[],
  rt: Runtime,
): CommandStartEvent {
  const opts = [...new Set(optionNames)]
    .filter((name) => OPT_NAME_RE.test(name))
    .slice(0, MAX_OPTS)
    .map((name) => name.slice(0, MAX_OPT_CHARS));
  return {
    event: 'command.start',
    cmd: cleanCmd(cmd),
    opts,
    ver: cleanVersion(rt.ver),
    node: cleanVersion(rt.node),
    os: clean(rt.os, OS_STRIP, 20),
  };
}

export function outcomeFor(exitCode: number): CommandOutcome {
  if (exitCode === 0) return 'ok';
  if (exitCode === 130) return 'interrupted';
  return 'failed';
}

export function commandFinish(cmd: string, exitCode: number, ms: number): CommandFinishEvent {
  return {
    event: 'command.finish',
    cmd: cleanCmd(cmd),
    outcome: outcomeFor(exitCode),
    // Safe integers only: the reader (`mm logs`) rejects anything JSON can't carry exactly.
    exit: Number.isSafeInteger(exitCode) ? exitCode : 1,
    ms: Number.isFinite(ms) && ms >= 0 ? Math.min(Math.round(ms), Number.MAX_SAFE_INTEGER) : 0,
  };
}

/** Printable ASCII without `"` and `\` (1 byte each in JSON), capped in bytes. */
function frameText(text: string): string {
  return text.replace(FRAME_STRIP, '?').slice(0, MAX_FRAME_BYTES);
}

/** file:// URL or absolute path → path relative to the package root; `<external>` otherwise. */
function rewriteLocation(location: string, root: string): string {
  // Only a real Node module path (`node:internal/process/task_queues:95:5`): a rewritten stack
  // could put a host or an address after `node:`.
  if (location.startsWith('node:'))
    return NODE_LOCATION_RE.test(location) ? location : '<external>';
  if (location === 'native' || location === '<anonymous>') return location;
  const lineCol = LINE_COL_RE.exec(location)?.[1] ?? '';
  let path = location.slice(0, location.length - lineCol.length);
  if (path.startsWith('file://')) {
    const converted = safeGet(() => fileURLToPath(path));
    if (converted === undefined) return '<external>';
    path = converted;
  }
  if (!isAbsolute(path)) return '<external>';
  // resolve() first: `<root>/../../home/x` must not count as inside the package.
  const rel = relative(root, resolve(path));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return '<external>';
  return `${rel.split(sep).join('/')}${lineCol}`;
}

/** Our own code (relative path) or Node internals: only there is a function name trusted. */
function trustedLocation(location: string): boolean {
  return location !== '<external>' && location !== 'native' && location !== '<anonymous>';
}

function frame(content: string, root: string): string {
  if (content.includes('eval at ')) return 'eval';
  const call = CALL_RE.exec(content);
  if (call === null) return frameText(rewriteLocation(content, root));
  const location = rewriteLocation(call[2] ?? '', root);
  // A stack text that isn't V8's own (overwritten `stack`, a library's rewrite) could put data
  // into the name slot: names of frames outside our code are never kept.
  const name = call[1] ?? '';
  const fn = trustedLocation(location) && FN_RE.test(name) ? name : '<fn>';
  return frameText(`${fn} (${location})`);
}

/**
 * Stack frames without the message. The header (`Name: message`) is cut by exact prefix —
 * a message can itself contain lines that look like frames, so "skip to the first `at`" would
 * let message text through. No recognisable header → no frames.
 */
export function stackFrames(err: Error, root: string): string[] {
  const stack = safeGet(() => err.stack);
  const message = safeGet(() => err.message);
  if (typeof stack !== 'string' || typeof message !== 'string') return [];
  const names = new Set<string>(['Error']);
  const name = safeGet(() => err.name);
  if (typeof name === 'string') names.add(name);
  const ctorName = safeGet(() => (err.constructor as { name?: unknown } | undefined)?.name);
  if (typeof ctorName === 'string') names.add(ctorName);

  // V8 writes `Name` for an empty message; a custom Error.prepareStackTrace (source-map
  // support, e.g. under Vitest) writes `Name: `. Both are safe: there is no message text.
  // Node's own errors add their code: `TypeError [ERR_INVALID_ARG_TYPE]: message`.
  const code = safeGet(() => (err as { code?: unknown }).code);
  const tags = typeof code === 'string' && CODE_RE.test(code) ? ['', ` [${code}]`] : [''];
  const headers = [...names].flatMap((n) =>
    tags.flatMap((tag) =>
      message === '' ? [`${n}${tag}`, `${n}${tag}: `] : [`${n}${tag}: ${message}`],
    ),
  );
  let rest: string | undefined;
  for (const header of headers) {
    if (stack === header || stack.startsWith(`${header}\n`)) {
      rest = stack.slice(header.length);
      break;
    }
  }
  if (rest === undefined) return [];

  // V8 frames are one contiguous block; the first other line (e.g. a library's appended
  // `Caused by: …` with its own message) ends it.
  const frames: string[] = [];
  for (const line of rest.split('\n').slice(1)) {
    const content = FRAME_RE.exec(line)?.[1];
    if (content === undefined) break;
    frames.push(frame(content, root));
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

/** `error.unexpected`: class, an allowlisted code and frames — never the message. */
export function unexpectedError(err: unknown, root: string): UnexpectedErrorEvent {
  const isError = safeGet(() => err instanceof Error) === true;
  const name = isError ? safeGet(() => (err as Error).name) : undefined;
  const errClass =
    typeof name === 'string' && CLASS_RE.test(name) ? name : isError ? 'Error' : 'NonError';
  const code =
    err !== null && typeof err === 'object'
      ? safeGet(() => (err as { code?: unknown }).code)
      : undefined;
  return {
    event: 'error.unexpected',
    errClass,
    ...(typeof code === 'string' && CODE_RE.test(code) && { code }),
    stack: isError ? stackFrames(err as Error, root) : [],
  };
}

/** Preset id (`websupport`, `custom`), or undefined for anything else. */
export function cleanProvider(id: unknown): string | undefined {
  return typeof id === 'string' && PROVIDER_RE.test(id) ? id : undefined;
}

/** A real 8-4-4-4-12 hex UUID, lowercased, or undefined for anything else. */
export function uuidOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  return UUID_RE.test(lower) ? lower : undefined;
}

/**
 * Runtime allowlist for an enum field: TypeScript types don't survive a caller bug or a
 * value passed through from elsewhere, so unknown values become `fallback`. `allowed` is a
 * Record over the union, so the compiler keeps it complete.
 */
export function oneOf<T extends string>(value: unknown, allowed: Record<T, true>, fallback: T): T {
  return typeof value === 'string' && Object.hasOwn(allowed, value) ? (value as T) : fallback;
}

/** A non-negative safe integer, else 0. */
export function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
