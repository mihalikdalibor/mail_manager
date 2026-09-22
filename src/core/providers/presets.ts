import { z } from 'zod';
import presetsJson from './presets.json' with { type: 'json' };
import { hostnameSchema, normalizeHost } from './email.js';

const presetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    group: z.enum(['sk-cz', 'global']),
    domains: z.array(hostnameSchema),
    mxSuffixes: z.array(hostnameSchema),
    /** null = per-mailbox host (the user must type it, see hostHint). */
    imap: z.strictObject({ host: hostnameSchema, port: z.literal(993) }).nullable(),
    altHosts: z.array(hostnameSchema),
    auth: z.array(z.enum(['password', 'app_password', 'oauth2'])).min(1),
    hint: z.string().optional(),
    hostHint: z.string().optional(),
    helpUrl: z.url({ protocol: /^https$/ }).optional(),
    verified: z.boolean(),
    /** Provider recognised but unusable today; the reason is shown to the user. */
    blocked: z.string().optional(),
  })
  .strict()
  .refine((p) => !p.verified || p.helpUrl !== undefined, 'verified presets need a helpUrl')
  .refine(
    (p) => p.imap !== null || p.hostHint !== undefined,
    'presets without imap need a hostHint',
  )
  .refine(
    (p) =>
      [...p.domains, ...p.mxSuffixes, ...p.altHosts, p.imap?.host ?? ''].every(
        (h) => h === h.toLowerCase(),
      ),
    'hosts must be lowercase',
  );

export type Preset = z.infer<typeof presetSchema>;

/** Validates a preset list: schema per entry plus unique ids, domains and MX suffixes. */
export function parsePresets(data: unknown): Preset[] {
  const presets = z.array(presetSchema).parse(data);
  const seen = new Map<string, string>();
  const claim = (kind: string, value: string, id: string): void => {
    const key = `${kind}:${value}`;
    const owner = seen.get(key);
    if (owner !== undefined)
      throw new Error(`Duplicate ${kind} "${value}" in presets ${owner} and ${id}`);
    seen.set(key, id);
  };
  for (const p of presets) {
    claim('id', p.id, p.id);
    for (const d of p.domains) claim('domain', d, p.id);
    for (const s of p.mxSuffixes) claim('mx suffix', s, p.id);
  }
  return presets;
}

/** Built-in presets. An invalid presets.json is a programming error: fail at load. */
export const PRESETS: readonly Preset[] = parsePresets(presetsJson);

export function findByDomain(
  domain: string,
  presets: readonly Preset[] = PRESETS,
): Preset | undefined {
  const d = domain.toLowerCase().replace(/\.$/, '');
  return presets.find((p) => p.domains.includes(d));
}

/** Matches an MX host against preset suffixes on a label boundary; the longest suffix wins. */
export function findByMxHost(
  mxHost: string,
  presets: readonly Preset[] = PRESETS,
): Preset | undefined {
  const host = normalizeHost(mxHost);
  if (host === null) return undefined;
  let best: { preset: Preset; length: number } | undefined;
  for (const preset of presets) {
    for (const suffix of preset.mxSuffixes) {
      if ((host === suffix || host.endsWith(`.${suffix}`)) && suffix.length > (best?.length ?? 0)) {
        best = { preset, length: suffix.length };
      }
    }
  }
  return best?.preset;
}

/** Presets in picker order: SK/CZ first, then global, each sorted by name. */
export function pickableProviders(presets: readonly Preset[] = PRESETS): Preset[] {
  const order = { 'sk-cz': 0, global: 1 } as const;
  return [...presets].sort(
    (a, b) => order[a.group] - order[b.group] || a.name.localeCompare(b.name, 'en'),
  );
}
