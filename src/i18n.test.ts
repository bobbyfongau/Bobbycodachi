import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Disable plugin loading in tests.
process.env.CODACHI_NO_PLUGINS = '1';

// Redirect os.homedir() to a per-test temp dir so locale-file tests are
// hermetic (a real ~/.config/codachi/locales must never leak into results).
const mocks = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => mocks.home,
    default: { ...actual.default, homedir: () => mocks.home },
  };
});

let localize: typeof import('./i18n.js')['localize'];
let getLocale: typeof import('./i18n.js')['getLocale'];

function writeUserLocale(name: string, data: unknown): void {
  const dir = path.join(mocks.home, '.config', 'codachi', 'locales');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data));
}

async function importI18n(): Promise<typeof import('./i18n.js')> {
  vi.resetModules();
  process.env.CODACHI_NO_PLUGINS = '1';
  return import('./i18n.js');
}

beforeEach(async () => {
  mocks.home = fs.mkdtempSync(path.join(tmpdir(), 'codachi-i18n-'));
  vi.resetModules();
  // Default: English locale, no plugins.
  delete process.env.CODACHI_LOCALE;
  delete process.env.LC_ALL;
  delete process.env.LANG;
  process.env.CODACHI_NO_PLUGINS = '1';
  const mod = await import('./i18n.js');
  localize = mod.localize;
  getLocale = mod.getLocale;
});

afterEach(() => {
  fs.rmSync(mocks.home, { recursive: true, force: true });
  delete process.env.CODACHI_LOCALE;
  delete process.env.LC_ALL;
  delete process.env.LANG;
});

describe('getLocale', () => {
  it('defaults to en', () => {
    expect(getLocale()).toBe('en');
  });

  it('reads CODACHI_LOCALE', async () => {
    process.env.CODACHI_LOCALE = 'zh';
    const mod = await importI18n();
    expect(mod.getLocale()).toBe('zh');
  });

  it('keeps a lowercased region suffix from CODACHI_LOCALE', async () => {
    process.env.CODACHI_LOCALE = 'zh_CN';
    const mod = await importI18n();
    expect(mod.getLocale()).toBe('zh_cn');
  });

  it('falls back to LANG', async () => {
    process.env.LANG = 'fr_FR.UTF-8';
    const mod = await importI18n();
    expect(mod.getLocale()).toBe('fr');
  });
});

describe('localize', () => {
  it('returns fallback for en locale', () => {
    const fallback = ['hello', 'world'];
    expect(localize('TEST_KEY', fallback)).toBe(fallback);
  });

  it('returns fallback for unknown key', () => {
    const obj = { a: [1, 2], b: [3] };
    expect(localize('NONEXISTENT', obj)).toBe(obj);
  });

  it('preserves array type', () => {
    const arr = ['one', 'two', 'three'];
    const result = localize('KEY', arr);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(arr);
  });

  it('preserves object type', () => {
    const obj = { cat: ['meow'], dog: ['woof'] };
    const result = localize('KEY', obj);
    expect(typeof result).toBe('object');
    expect(result).toEqual(obj);
  });

  it('preserves string type', () => {
    expect(localize('KEY', 'hello')).toBe('hello');
  });

  it('preserves number type', () => {
    expect(localize('KEY', 42)).toBe(42);
  });
});

describe('locale file loading', () => {
  it('loads a user locale file from ~/.config/codachi/locales', async () => {
    writeUserLocale('zh', { TEST_POOL: ['中文一', '中文二'] });
    process.env.CODACHI_LOCALE = 'zh';
    const mod = await importI18n();
    expect(mod.localize('TEST_POOL', ['en one', 'en two'])).toEqual(['中文一', '中文二']);
  });

  it('loads the bundled locale via a real filesystem path (fileURLToPath)', async () => {
    // No user locale file exists in the fake home, so this must come from the
    // bundled locales/ dir next to i18n.ts — resolvable only if import.meta.url
    // is converted with fileURLToPath (URL.pathname keeps %-encoding and the
    // leading /C: on Windows, which broke the lookup silently).
    process.env.CODACHI_LOCALE = 'zh';
    const mod = await importI18n();
    const pool = mod.localize('BUSY_MESSAGES', ['english busy']);
    expect(pool).toContain('正在干活!');
  });

  it('falls back from zh_CN to the base zh locale file', async () => {
    writeUserLocale('zh', { TEST_POOL: ['中文'] });
    process.env.CODACHI_LOCALE = 'zh_CN';
    const mod = await importI18n();
    expect(mod.localize('TEST_POOL', ['english'])).toEqual(['中文']);
  });

  it('falls back from zh-CN (dash form) to the base zh locale file', async () => {
    writeUserLocale('zh', { TEST_POOL: ['中文'] });
    process.env.CODACHI_LOCALE = 'zh-CN';
    const mod = await importI18n();
    expect(mod.localize('TEST_POOL', ['english'])).toEqual(['中文']);
  });

  it('prefers an exact region locale file over the base one', async () => {
    writeUserLocale('zh', { TEST_POOL: ['通用中文'] });
    writeUserLocale('zh_cn', { TEST_POOL: ['简体中文'] });
    process.env.CODACHI_LOCALE = 'zh_CN';
    const mod = await importI18n();
    expect(mod.localize('TEST_POOL', ['english'])).toEqual(['简体中文']);
  });
});

describe('merge behavior', () => {
  it('ignores an empty-array locale override so pools never go empty', async () => {
    writeUserLocale('zh', { TEST_POOL: [] });
    process.env.CODACHI_LOCALE = 'zh';
    const mod = await importI18n();
    const fallback = ['english one', 'english two'];
    expect(mod.localize('TEST_POOL', fallback)).toEqual(fallback);
  });

  it('ignores an empty-array override nested inside an object pool', async () => {
    writeUserLocale('zh', { NESTED: { cat: [] } });
    process.env.CODACHI_LOCALE = 'zh';
    const mod = await importI18n();
    const result = mod.localize('NESTED', { cat: ['meow'], dog: ['woof'] });
    expect(result).toEqual({ cat: ['meow'], dog: ['woof'] });
  });

  it('ignores an empty-array plugin override', async () => {
    vi.resetModules();
    process.env.CODACHI_NO_PLUGINS = '1';
    const store = await import('./plugin-store.js');
    store.PLUGIN_MESSAGES['TEST_POOL'] = [];
    const mod = await import('./i18n.js');
    const fallback = ['default 1', 'default 2'];
    expect(mod.localize('TEST_POOL', fallback)).toEqual(fallback);
    delete store.PLUGIN_MESSAGES['TEST_POOL'];
  });

  it('plugin overrides are merged into defaults', async () => {
    vi.resetModules();
    process.env.CODACHI_NO_PLUGINS = '1';
    // Manually populate plugin store before importing i18n
    const store = await import('./plugin-store.js');
    store.PLUGIN_MESSAGES['TEST_POOL'] = ['plugin msg 1', 'plugin msg 2'];
    const mod = await import('./i18n.js');
    const result = mod.localize('TEST_POOL', ['default 1', 'default 2']);
    expect(result).toEqual(['plugin msg 1', 'plugin msg 2']);
    // Clean up
    delete store.PLUGIN_MESSAGES['TEST_POOL'];
  });

  it('plugin object overrides merge key-by-key', async () => {
    vi.resetModules();
    process.env.CODACHI_NO_PLUGINS = '1';
    const store = await import('./plugin-store.js');
    store.PLUGIN_MESSAGES['NESTED'] = { cat: ['custom cat'] };
    const mod = await import('./i18n.js');
    const result = mod.localize('NESTED', { cat: ['default cat'], dog: ['default dog'] });
    expect(result).toEqual({ cat: ['custom cat'], dog: ['default dog'] });
    delete store.PLUGIN_MESSAGES['NESTED'];
  });

  it('adopts brand-new nested keys contributed by plugins', async () => {
    vi.resetModules();
    process.env.CODACHI_NO_PLUGINS = '1';
    const store = await import('./plugin-store.js');
    store.PLUGIN_MESSAGES['EVENT_POOL'] = { deploy: ['shipped!'] };
    const mod = await import('./i18n.js');
    const result = mod.localize<Record<string, string[]>>('EVENT_POOL', {
      test_passed: ['green!'],
    });
    expect(result.test_passed).toEqual(['green!']);
    expect(result.deploy).toEqual(['shipped!']);
    delete store.PLUGIN_MESSAGES['EVENT_POOL'];
  });

  it('drops a brand-new key whose value is an empty array', async () => {
    vi.resetModules();
    process.env.CODACHI_NO_PLUGINS = '1';
    const store = await import('./plugin-store.js');
    store.PLUGIN_MESSAGES['EVENT_POOL'] = { deploy: [] };
    const mod = await import('./i18n.js');
    const result = mod.localize<Record<string, string[]>>('EVENT_POOL', {
      test_passed: ['green!'],
    });
    expect(result.test_passed).toEqual(['green!']);
    expect('deploy' in result).toBe(false);
    delete store.PLUGIN_MESSAGES['EVENT_POOL'];
  });

  it('adopts new nested keys from a locale file too', async () => {
    writeUserLocale('zh', { EVENT_POOL: { deploy: ['部署完成!'] } });
    process.env.CODACHI_LOCALE = 'zh';
    const mod = await importI18n();
    const result = mod.localize<Record<string, string[]>>('EVENT_POOL', {
      test_passed: ['green!'],
    });
    expect(result.test_passed).toEqual(['green!']);
    expect(result.deploy).toEqual(['部署完成!']);
  });
});
