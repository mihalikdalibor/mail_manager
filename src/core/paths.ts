import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EnvSource } from './config.js';

/** Config dir: MM_CONFIG_DIR → $XDG_CONFIG_HOME/mail-manager → ~/.config/mail-manager. */
export function configDir(env: EnvSource = process.env): string {
  const explicit = env['MM_CONFIG_DIR']?.trim();
  if (explicit) return explicit;
  const xdg = env['XDG_CONFIG_HOME']?.trim();
  return join(xdg || join(homedir(), '.config'), 'mail-manager');
}

/** Local log files (app-*.log, security-*.log) live next to the session file. */
export function logDir(env: EnvSource = process.env): string {
  return join(configDir(env), 'logs');
}
