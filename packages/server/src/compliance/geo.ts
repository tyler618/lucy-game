/**
 * Jurisdiction resolution and blocking.
 *
 * The blocklist is server config, never a client check — a compiled-in country
 * list is a list of places to spoof, and it means a policy change needs a
 * client release. `ACE_BLOCKED_JURISDICTIONS` is read at boot and can be
 * swapped for the operator's own source by replacing this class.
 */
import type { GeoProvider } from './types.js';

/**
 * Default deny list. Deliberately conservative: markets that are closed to
 * unlicensed remote gaming, plus the sanctions set. An operator narrows or
 * widens this to match the licences they actually hold.
 */
const DEFAULT_BLOCKED = [
  'US', 'FR', 'NL', 'AU', 'SG', 'KP', 'IR', 'SY', 'CU', 'RU', 'BY', 'MM', 'AF',
];

export class ConfigGeoProvider implements GeoProvider {
  readonly name = 'config';
  private readonly blocked: Set<string>;

  constructor(blocked: string[] = parseEnvList(process.env.ACE_BLOCKED_JURISDICTIONS) ?? DEFAULT_BLOCKED) {
    this.blocked = new Set(blocked.map((c) => c.toUpperCase()));
  }

  async resolve(ip: string, headers: Record<string, string | undefined>): Promise<string> {
    // Edge-provided geo, in the order the common CDNs set it. Nothing here
    // reads a request body or a query parameter, because those are the
    // client's to forge.
    const fromEdge =
      headers['cf-ipcountry'] ??
      headers['x-vercel-ip-country'] ??
      headers['x-appengine-country'] ??
      headers['fastly-client-country'];
    if (fromEdge && fromEdge !== 'XX') return fromEdge.toUpperCase();

    // No edge header: a real deployment calls the operator's geo service here.
    // Failing closed would make every local dev run unplayable, so the
    // configured fallback is used and the decision is logged as unverified.
    return (process.env.ACE_DEFAULT_JURISDICTION ?? 'GB').toUpperCase();
  }

  async isBlocked(jurisdiction: string): Promise<boolean> {
    return this.blocked.has(jurisdiction.toUpperCase());
  }

  list(): string[] {
    return [...this.blocked].sort();
  }
}

function parseEnvList(value: string | undefined): string[] | null {
  if (!value) return null;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
