import type { LineError } from '../core/filters/line.js';
import { sanitize } from './log-text.js';

// The filter line's plain words (M3a): why a line can't be read, and the names of the orders.
// ASCII only. The token is what the user typed, so it goes through sanitize() like every echoed
// value.

/** What the line says about a term it can't read: what happened and what to write instead. */
export function lineErrorText(error: LineError): string {
  const token = sanitize(error.token);
  switch (error.code) {
    case 'unclosed-quote':
      return 'A quote (") is not closed.';
    case 'unknown-key':
      return `Don't know "${token}" - the keys are from: to: cc: subject: older: newer: since: before: date: larger: smaller:`;
    case 'empty-value':
      return `"${token}" needs a value, e.g. from:shop.sk`;
    case 'bad-age':
      return `Can't read "${token}" - write an age like older:30d, older:6m or older:2y.`;
    case 'bad-date':
      return `Can't read "${token}" - write a date like since:2023-01-31 or date:2023-01..2023-06.`;
    case 'bad-size':
      return `Can't read "${token}" - write a size like larger:500kb or larger:5mb.`;
    case 'mixed-addresses':
      return `"${token}" mixes addresses and plain words - use one kind per key.`;
    case 'no-negation':
      return `"${token}" can't be turned around - use since: and before: instead.`;
    case 'too-long':
      return 'The filter is too long - use fewer words.';
    case 'unsupported':
      return "This filter isn't supported yet - try a simpler one.";
  }
}

/** The order as the status line names it. */
export function orderText(order: 'newest' | 'oldest' | 'largest'): string {
  switch (order) {
    case 'newest':
      return 'newest first';
    case 'oldest':
      return 'oldest first';
    case 'largest':
      return 'largest first';
  }
}
