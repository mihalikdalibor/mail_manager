import { describe, it, expect, vi } from 'vitest';
import {
  CANCEL_CHOICE,
  MANUAL_CHOICE,
  chooseImapSettings,
  type PromptChoice,
  type PromptFns,
} from '../../src/cli/prompts/imap-settings.js';
import type { DiscoveryResult, ProviderInfo } from '../../src/core/providers/discover.js';
import { parseEmail } from '../../src/core/providers/email.js';
import { PRESETS, type Preset } from '../../src/core/providers/presets.js';

const email = parseEmail('someone@example-test-domain.eu');

function preset(overrides: Partial<Preset> & Pick<Preset, 'id' | 'name'>): Preset {
  return {
    group: 'global',
    domains: [],
    mxSuffixes: [],
    imap: { host: `imap.${overrides.id}.example.com`, port: 993 },
    altHosts: [],
    auth: ['password'],
    verified: true,
    helpUrl: 'https://example.com/help',
    ...overrides,
  };
}

const LIST: Preset[] = [
  preset({ id: 'zglobal', name: 'Zulu Global' }),
  preset({ id: 'sk2', name: 'Seznam', group: 'sk-cz' }),
  preset({ id: 'aglobal', name: 'Alpha Global', verified: false }),
  preset({ id: 'sk1', name: 'Active24', group: 'sk-cz' }),
  preset({
    id: 'nohost',
    name: 'NoHost',
    group: 'sk-cz',
    imap: null,
    hostHint: 'Find it in the NoHost admin panel',
  }),
  preset({ id: 'blocked', name: 'Blocky', blocked: 'Blocky disabled password IMAP' }),
];

const manualResult: DiscoveryResult = { status: 'manual', email, notices: [], tried: [] };

function needsHost(provider: ProviderInfo): DiscoveryResult {
  return { status: 'needs-host', source: 'preset-mx', provider, email, notices: [], tried: [] };
}

function prompts(): {
  fns: PromptFns;
  select: ReturnType<typeof vi.fn<PromptFns['select']>>;
  input: ReturnType<typeof vi.fn<PromptFns['input']>>;
} {
  const select = vi.fn<PromptFns['select']>();
  const input = vi.fn<PromptFns['input']>();
  return { fns: { select, input }, select, input };
}

type SelectConfig = Parameters<PromptFns['select']>[0];
type InputConfig = Parameters<PromptFns['input']>[0];

function isChoice(c: SelectConfig['choices'][number]): c is PromptChoice {
  return 'value' in c;
}

describe('chooseImapSettings: manual → select', () => {
  it('builds the choice list in the specified order', async () => {
    const p = prompts();
    p.select.mockResolvedValue(CANCEL_CHOICE);
    await chooseImapSettings(manualResult, p.fns, LIST);
    expect(p.select).toHaveBeenCalledTimes(1);
    const config = p.select.mock.calls[0]?.[0] as SelectConfig;
    const shape = config.choices.map((c) => (isChoice(c) ? c.value : `sep:${c.separator}`));
    expect(shape).toEqual([
      'sep:Slovakia / Czechia',
      'sk1',
      'nohost',
      'sk2',
      'sep:Global',
      'aglobal',
      'blocked',
      'zglobal',
      'sep:',
      MANUAL_CHOICE,
      CANCEL_CHOICE,
    ]);
    const choices = config.choices.filter(isChoice);
    const byValue = new Map(choices.map((c) => [c.value, c]));
    expect(byValue.get(MANUAL_CHOICE)?.name).toBe('Enter IMAP host manually');
    expect(byValue.get(CANCEL_CHOICE)?.name).toBe('Cancel');
    expect(byValue.get('blocked')?.disabled).toBe('Blocky disabled password IMAP');
    expect(byValue.get('aglobal')?.name.endsWith(' (unverified)')).toBe(true);
    expect(byValue.get('zglobal')?.name.endsWith(' (unverified)')).toBe(false);
    expect(byValue.get('zglobal')?.disabled ?? false).toBeFalsy();
  });

  it('uses the shipped presets by default', async () => {
    const p = prompts();
    p.select.mockResolvedValue(CANCEL_CHOICE);
    await chooseImapSettings(manualResult, p.fns);
    const config = p.select.mock.calls[0]?.[0] as SelectConfig;
    const values = config.choices.filter(isChoice).map((c) => c.value);
    for (const preset of PRESETS) expect(values).toContain(preset.id);
    const outlook = config.choices.filter(isChoice).find((c) => c.value === 'outlook');
    expect(typeof outlook?.disabled).toBe('string');
  });

  it('picking a preset with imap returns its settings without input prompts', async () => {
    const p = prompts();
    p.select.mockResolvedValue('sk1');
    const r = await chooseImapSettings(manualResult, p.fns, LIST);
    expect(r?.settings).toEqual({
      host: 'imap.sk1.example.com',
      port: 993,
      username: email.address,
    });
    expect(r?.source).toBe('picked');
    expect(r?.provider?.id).toBe('sk1');
    expect(r?.provider?.name).toBe('Active24');
    expect(p.input).not.toHaveBeenCalled();
  });

  it('picking a preset without imap asks for the host with its hint', async () => {
    const p = prompts();
    p.select.mockResolvedValue('nohost');
    p.input.mockResolvedValue('Imap.NoHost.Example.com');
    const r = await chooseImapSettings(manualResult, p.fns, LIST);
    expect(p.input).toHaveBeenCalledTimes(1);
    const cfg = p.input.mock.calls[0]?.[0] as InputConfig;
    expect(cfg.message).toContain('Find it in the NoHost admin panel');
    expect(r).toEqual({
      settings: { host: 'imap.nohost.example.com', port: 993, username: email.address },
      source: 'picked',
      provider: expect.objectContaining({ id: 'nohost' }) as unknown,
    });
  });

  it('host validate accepts valid hosts and returns messages for invalid ones', async () => {
    const p = prompts();
    p.select.mockResolvedValue('nohost');
    p.input.mockResolvedValue('imap.x.sk');
    await chooseImapSettings(manualResult, p.fns, LIST);
    const validate = (p.input.mock.calls[0]?.[0] as InputConfig).validate;
    expect(validate).toBeTypeOf('function');
    if (!validate) return;
    expect(validate('imap.x.sk')).toBe(true);
    expect(validate('IMAP.X.SK.')).toBe(true);
    for (const bad of ['1.2.3.4', 'localhost', 'imap.x.sk:993', 'imaps://imap.x.sk', '']) {
      const res = validate(bad);
      expect(typeof res).toBe('string');
      expect((res as string).length).toBeGreaterThan(0);
    }
  });

  it('manual entry asks host then username; normalises the host', async () => {
    const p = prompts();
    p.select.mockResolvedValue(MANUAL_CHOICE);
    p.input.mockResolvedValueOnce('IMAP.X.SK').mockResolvedValueOnce('login-1');
    const r = await chooseImapSettings(manualResult, p.fns, LIST);
    expect(p.input).toHaveBeenCalledTimes(2);
    const hostCfg = p.input.mock.calls[0]?.[0] as InputConfig;
    const userCfg = p.input.mock.calls[1]?.[0] as InputConfig;
    expect(hostCfg.validate?.('localhost')).toBeTypeOf('string');
    expect(hostCfg.validate?.('imap.x.sk')).toBe(true);
    expect(userCfg.default).toBe(email.address);
    expect(userCfg.validate?.('a\u001bb')).toBeTypeOf('string');
    expect(userCfg.validate?.('login-1')).toBe(true);
    expect(r?.settings).toEqual({ host: 'imap.x.sk', port: 993, username: 'login-1' });
    expect(r?.source).toBe('manual');
    expect(r?.provider).toBeUndefined();
  });

  it('manual entry with an empty username uses the email address', async () => {
    const p = prompts();
    p.select.mockResolvedValue(MANUAL_CHOICE);
    p.input.mockResolvedValueOnce('imap.x.sk').mockResolvedValueOnce('');
    const r = await chooseImapSettings(manualResult, p.fns, LIST);
    expect(r?.settings.username).toBe(email.address);
  });

  it('Cancel returns null', async () => {
    const p = prompts();
    p.select.mockResolvedValue(CANCEL_CHOICE);
    expect(await chooseImapSettings(manualResult, p.fns, LIST)).toBeNull();
    expect(p.input).not.toHaveBeenCalled();
  });

  it('propagates prompt errors (Ctrl+C)', async () => {
    const p = prompts();
    const cancel = new Error('User force closed the prompt with SIGINT');
    cancel.name = 'ExitPromptError';
    p.select.mockRejectedValue(cancel);
    await expect(chooseImapSettings(manualResult, p.fns, LIST)).rejects.toBe(cancel);
  });
});

describe('chooseImapSettings: needs-host', () => {
  const provider: ProviderInfo = {
    id: 'wedos',
    name: 'WEDOS',
    verified: true,
    auth: ['password'],
    hostHint: 'Look up the server name in WEDOS customer admin',
  };

  it('asks only for the host, using the provider hint', async () => {
    const p = prompts();
    p.input.mockResolvedValue('Imap.Example-Test-Domain.eu');
    const r = await chooseImapSettings(needsHost(provider), p.fns, LIST);
    expect(p.select).not.toHaveBeenCalled();
    expect(p.input).toHaveBeenCalledTimes(1);
    const cfg = p.input.mock.calls[0]?.[0] as InputConfig;
    expect(cfg.message).toContain(provider.hostHint);
    expect(cfg.validate?.('1.2.3.4')).toBeTypeOf('string');
    expect(r).toEqual({
      settings: { host: 'imap.example-test-domain.eu', port: 993, username: email.address },
      source: 'host-entered',
      provider,
    });
  });

  it('propagates prompt errors', async () => {
    const p = prompts();
    const cancel = new Error('closed');
    cancel.name = 'ExitPromptError';
    p.input.mockRejectedValue(cancel);
    await expect(chooseImapSettings(needsHost(provider), p.fns, LIST)).rejects.toBe(cancel);
  });
});
