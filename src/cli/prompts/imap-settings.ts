import { input, select, Separator } from '@inquirer/prompts';
import {
  providerInfo,
  type DiscoveryResult,
  type ProviderInfo,
} from '../../core/providers/discover.js';
import type { ParsedEmail } from '../../core/providers/email.js';
import { pickableProviders, PRESETS, type Preset } from '../../core/providers/presets.js';
import {
  manualSettings,
  settingsFromPreset,
  validateManualHost,
  validateManualUsername,
  type ImapSettings,
} from '../../core/providers/settings.js';

export interface PromptChoice {
  name: string;
  value: string;
  disabled?: boolean | string;
}

/** The two prompts the flow needs; injected so tests can pass fakes. */
export interface PromptFns {
  select(config: {
    message: string;
    choices: (PromptChoice | { separator: string })[];
    pageSize?: number;
  }): Promise<string>;
  input(config: {
    message: string;
    default?: string;
    validate?: (value: string) => boolean | string;
  }): Promise<string>;
}

export const MANUAL_CHOICE = '__manual__';
export const CANCEL_CHOICE = '__cancel__';

export interface ChosenSettings {
  settings: ImapSettings;
  /** picked = chosen from the list; host-entered = provider known, host typed; manual = both typed. */
  source: 'picked' | 'host-entered' | 'manual';
  provider?: ProviderInfo;
}

/** Real terminal prompts (@inquirer/prompts). */
export const inquirerPrompts: PromptFns = {
  select: (config) =>
    select<string>({
      message: config.message,
      ...(config.pageSize !== undefined && { pageSize: config.pageSize }),
      choices: config.choices.map((c) =>
        'separator' in c ? new Separator(c.separator || ' ') : c,
      ),
    }),
  input: (config) => input(config),
};

/** Turns a validator that throws into an inquirer `validate` (true or the error message). */
function asValidate(check: (value: string) => unknown): (value: string) => boolean | string {
  return (value) => {
    try {
      check(value);
      return true;
    } catch (err) {
      return err instanceof Error ? err.message : 'Invalid value';
    }
  };
}

async function askHost(prompts: PromptFns, hostHint?: string): Promise<string> {
  const message = hostHint === undefined ? 'IMAP host' : `IMAP host (${hostHint})`;
  const answer = await prompts.input({ message, validate: asValidate(validateManualHost) });
  return validateManualHost(answer);
}

async function hostForProvider(
  provider: ProviderInfo,
  email: ParsedEmail,
  prompts: PromptFns,
  source: ChosenSettings['source'],
): Promise<ChosenSettings> {
  const host = await askHost(prompts, provider.hostHint);
  return { settings: manualSettings({ host }, email), source, provider };
}

function choicesFor(presets: readonly Preset[]): (PromptChoice | { separator: string })[] {
  const toChoice = (p: Preset): PromptChoice => ({
    name: p.verified ? p.name : `${p.name} (unverified)`,
    value: p.id,
    ...(p.blocked !== undefined && { disabled: p.blocked }),
  });
  const sorted = pickableProviders(presets);
  return [
    { separator: 'Slovakia / Czechia' },
    ...sorted.filter((p) => p.group === 'sk-cz').map(toChoice),
    { separator: 'Global' },
    ...sorted.filter((p) => p.group === 'global').map(toChoice),
    { separator: '' },
    { name: 'Enter IMAP host manually', value: MANUAL_CHOICE },
    { name: 'Cancel', value: CANCEL_CHOICE },
  ];
}

/**
 * Tiers 2 and 3 after autodetect: pick the provider from the preset list, or type the
 * IMAP host manually. Returns null when the user cancels. Prompt errors (Ctrl+C) propagate.
 */
export async function chooseImapSettings(
  result: DiscoveryResult,
  prompts: PromptFns,
  presets: readonly Preset[] = PRESETS,
): Promise<ChosenSettings | null> {
  const { email } = result;
  if (result.status === 'needs-host') {
    return hostForProvider(result.provider, email, prompts, 'host-entered');
  }

  const choice = await prompts.select({
    message: 'Choose your email provider',
    choices: choicesFor(presets),
    pageSize: 15,
  });
  if (choice === CANCEL_CHOICE) return null;
  if (choice === MANUAL_CHOICE) {
    const host = await askHost(prompts);
    const username = await prompts.input({
      message: 'IMAP username',
      default: email.address,
      validate: asValidate((v) => validateManualUsername(v, email)),
    });
    return { settings: manualSettings({ host, username }, email), source: 'manual' };
  }
  const preset = presets.find((p) => p.id === choice);
  if (preset === undefined || preset.blocked !== undefined) return null;
  const settings = settingsFromPreset(preset, email);
  if (settings === null) return hostForProvider(providerInfo(preset), email, prompts, 'picked');
  return { settings, source: 'picked', provider: providerInfo(preset) };
}
