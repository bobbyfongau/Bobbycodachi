/**
 * Tiny i18n shim for codachi messages.
 *
 * Strategy: keep the English message files as the canonical / default source.
 * At module load time, each message export is wrapped in `localize(key, default)`.
 * If a locale file exists for the current locale AND it contains an override
 * for `key`, we return the override (structure-merged for object-shaped pools
 * like EVENT_MESSAGES). Otherwise we return the default unchanged.
 *
 * Locale detection (first match wins):
 *   1. CODACHI_LOCALE env var                    — explicit user override
 *   2. `locale` field in ~/.config/codachi/config.json (not yet wired)
 *   3. LANG / LC_ALL env vars, first two chars   — OS default
 *   4. 'en'                                       — ultimate fallback
 *
 * Locale file lookup (first existing wins):
 *   1. ~/.config/codachi/locales/<locale>.json   — user override
 *   2. <dist>/locales/<locale>.json              — bundled (optional)
 *
 * A locale file is a flat JSON object whose keys match the message export
 * names, e.g.:
 *
 *   {
 *     "BUSY_MESSAGES": ["正在做事情~", "一起加油!"],
 *     "EVENT_MESSAGES": { "test_passed": { "hot": ["全绿! *happy dance*"] } }
 *   }
 *
 * Missing keys fall through to English — translators can ship partial locales
 * without breaking anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { logError, logWarn } from './log.js';
import { loadPlugins } from './plugins.js';
import { PLUGIN_MESSAGES } from './plugin-store.js';

// Top-level await: load plugins BEFORE any messages/*.ts module evaluates.
// Because i18n.ts is the first thing every messages file imports, we're
// guaranteed to run first — message defaults are then wrapped by localize()
// which can see plugin overrides.
//
// If disabled via CODACHI_NO_PLUGINS=1 (or tests), we skip the scan entirely
// so unrelated code paths don't pay the import-resolution cost.
if (process.env.CODACHI_NO_PLUGINS !== '1') {
  try {
    await loadPlugins();
  } catch (err) {
    logError('i18n.loadPlugins', err);
  }
}

function detectLocale(): string {
  const override = process.env.CODACHI_LOCALE;
  if (override) return override.toLowerCase().slice(0, 5);
  const sys = process.env.LC_ALL || process.env.LANG || '';
  if (sys) {
    const short = sys.toLowerCase().slice(0, 2);
    if (short) return short;
  }
  return 'en';
}

const LOCALE = detectLocale();

function loadLocaleFile(): Record<string, unknown> {
  if (LOCALE === 'en') return {}; // English is the source — no file needed.

  // Exact locale first (e.g. zh_cn.json), then the base language (zh.json)
  // so CODACHI_LOCALE=zh_CN still finds a bundled zh.json. English is the
  // source — never probe for en.json.
  const names = [LOCALE];
  const base = LOCALE.slice(0, 2);
  if (base !== LOCALE && base !== 'en') names.push(base);

  const candidates: string[] = [];
  // Bundled locales, if shipped: dist/locales/<locale>.json relative to this file.
  let here: string | undefined;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    // ignored — not fatal if import.meta.url isn't resolvable
  }
  for (const name of names) {
    candidates.push(path.join(os.homedir(), '.config', 'codachi', 'locales', `${name}.json`));
    if (here) candidates.push(path.join(here, 'locales', `${name}.json`));
  }

  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      logWarn('i18n', `locale file ${p} is not an object`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        logError('i18n.load:' + p, err);
      }
    }
  }
  return {};
}

const LOCALE_DATA: Record<string, unknown> = loadLocaleFile();

/**
 * Deep-merge a locale override onto the default structure.
 *   - For primitives and arrays: override wins if it's the same shape.
 *   - For plain objects: merge key-by-key so translators can override just a
 *     few entries of a big nested pool (e.g. EVENT_MESSAGES.test_passed only).
 */
/**
 * Sanitize a brand-new (plugin-contributed) value the fallback doesn't know
 * about: empty arrays are dropped at ANY depth so pickers never see a pool
 * they'd index with `tick % 0`. Returns undefined when nothing survives.
 */
function dropEmptyPools(v: unknown): unknown {
  if (Array.isArray(v)) return v.length > 0 ? v : undefined;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    let kept = false;
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
      const cleaned = dropEmptyPools(inner);
      if (cleaned !== undefined) { out[k] = cleaned; kept = true; }
    }
    return kept ? out : undefined;
  }
  return v;
}

function merge<T>(fallback: T, override: unknown): T {
  if (override === undefined || override === null) return fallback;

  // Arrays: override must be a non-empty array to be accepted; otherwise
  // fallback wins. An empty pool would make pickers index with `tick % 0`
  // (NaN) and the statusline would render the literal string "undefined".
  if (Array.isArray(fallback)) {
    return Array.isArray(override) && override.length > 0 ? (override as T) : fallback;
  }

  // Plain object: recursively merge.
  if (fallback && typeof fallback === 'object') {
    if (typeof override !== 'object' || Array.isArray(override)) return fallback;
    const fallbackObj = fallback as Record<string, unknown>;
    const out: Record<string, unknown> = { ...fallbackObj };
    for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
      // Keys the fallback doesn't know about are adopted as-is — that's how
      // plugins contribute brand-new entries (e.g. a new EVENT_MESSAGES key).
      // Empty-array pools are dropped so `if (pool)` guards keep working.
      if (k in fallbackObj) {
        out[k] = merge(fallbackObj[k], v);
      } else {
        const adopted = dropEmptyPools(v);
        if (adopted !== undefined) out[k] = adopted;
      }
    }
    return out as T;
  }

  // Primitives: straightforward override.
  return (typeof override === typeof fallback ? override : fallback) as T;
}

export function localize<T>(key: string, fallback: T): T {
  // Precedence (outermost wins): locale file > plugin override > default.
  // We merge in that order so the user's chosen language is always the final
  // say, but plugins can still contribute new entries the locale file doesn't
  // know about.
  let current = fallback;
  const pluginOverride = PLUGIN_MESSAGES[key];
  if (pluginOverride !== undefined) current = merge(current, pluginOverride);
  if (LOCALE !== 'en') {
    const localeOverride = LOCALE_DATA[key];
    if (localeOverride !== undefined) current = merge(current, localeOverride);
  }
  return current;
}

export function getLocale(): string { return LOCALE; }
