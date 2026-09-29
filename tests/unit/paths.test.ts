import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { configDir, logDir } from '../../src/core/paths.js';

describe('configDir', () => {
  it('prefers MM_CONFIG_DIR', () => {
    expect(configDir({ MM_CONFIG_DIR: '/tmp/mm-a', XDG_CONFIG_HOME: '/tmp/xdg' })).toBe(
      '/tmp/mm-a',
    );
  });

  it('trims MM_CONFIG_DIR', () => {
    expect(configDir({ MM_CONFIG_DIR: '  /tmp/mm-a  ' })).toBe('/tmp/mm-a');
  });

  it('falls back to XDG_CONFIG_HOME/mail-manager', () => {
    expect(configDir({ MM_CONFIG_DIR: '', XDG_CONFIG_HOME: '/tmp/xdg' })).toBe(
      join('/tmp/xdg', 'mail-manager'),
    );
  });

  it('falls back to ~/.config/mail-manager', () => {
    expect(configDir({})).toBe(join(homedir(), '.config', 'mail-manager'));
    expect(configDir({ MM_CONFIG_DIR: '', XDG_CONFIG_HOME: '' })).toBe(
      join(homedir(), '.config', 'mail-manager'),
    );
  });
});

describe('logDir', () => {
  it('is <config dir>/logs', () => {
    expect(logDir({ MM_CONFIG_DIR: '/tmp/mm-a' })).toBe(join('/tmp/mm-a', 'logs'));
    expect(logDir({})).toBe(join(homedir(), '.config', 'mail-manager', 'logs'));
  });
});
