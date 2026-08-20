/**
 * codachi init — auto-configure Claude Code's ~/.claude/settings.json.
 *
 * Adds a statusLine entry and a PostToolUse hook. The commands it writes
 * depend on how codachi is running:
 *
 *   - When installed globally or via `npx codachi init` (argv[1] resolved to
 *     a node_modules or npx cache path), we prefer the bin names `codachi`
 *     and `codachi-hook` — they're short, version-stable, and don't bake
 *     absolute paths into the user's settings.
 *   - When run from a local clone (`node dist/index.js init`), we fall back
 *     to absolute `node /path/to/dist/*.js` so the install still works even
 *     if the clone is not on PATH.
 *
 * Idempotent: if a codachi statusLine / hook already exists, it updates in
 * place rather than duplicating.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const SETTINGS_FILE = path.join(os.homedir(), '.claude', 'settings.json');

/** The Claude Code hook event codachi listens on. */
const HOOK_EVENT = 'PostToolUse';
/** Old, incorrect event name earlier versions registered under — cleaned up on init/uninstall. */
const LEGACY_HOOK_EVENT = 'PostToolExecution';

function detectMode(): { statusCmd: string; hookCmd: string; mode: 'bin' | 'local' } {
  const entry = process.argv[1] || '';
  const fromNodeModules = entry.includes(`${path.sep}node_modules${path.sep}`);
  const fromNpxCache = entry.includes(`${path.sep}_npx${path.sep}`) || entry.includes(`${path.sep}.npm${path.sep}`);

  // `npx codachi init` is the dream path: settings reference the short bin
  // names and npx resolves them each run.
  if (fromNodeModules || fromNpxCache) {
    return { statusCmd: 'codachi', hookCmd: 'codachi-hook', mode: 'bin' };
  }

  // Local dev: absolute paths into the clone. fileURLToPath (not URL.pathname)
  // so paths with spaces / non-ASCII / Windows drive letters resolve correctly.
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const indexPath = path.join(distDir, 'index.js');
  const hookPath = path.join(distDir, 'hook.js');
  if (!fs.existsSync(indexPath)) {
    console.error('Error: dist/index.js not found. Run `npm run build` first.');
    process.exit(1);
  }
  return {
    statusCmd: `node "${indexPath}"`,
    hookCmd: `node "${hookPath}"`,
    mode: 'local',
  };
}

function isCodachiCommand(cmd: unknown): boolean {
  return typeof cmd === 'string' && /codachi(-hook)?|codachi[\\/]dist[\\/]hook/.test(cmd);
}

/**
 * True if a hook entry references codachi — either the current schema
 * ({matcher, hooks: [{type, command}]}) or the legacy flat {matcher, command}
 * shape written by older codachi versions.
 */
function referencesCodachi(h: unknown): boolean {
  const hook = h as Record<string, unknown>;
  if (isCodachiCommand(hook.command)) return true;
  if (Array.isArray(hook.hooks)) {
    return hook.hooks.some((inner) => isCodachiCommand((inner as Record<string, unknown>).command));
  }
  return false;
}

/**
 * Read and parse settings.json.
 *
 * Returns {} when the file doesn't exist. When the file exists but can't be
 * read or parsed, returns null — callers must abort rather than write, so a
 * user's hand-edited (or half-written) settings file is never destroyed.
 */
function loadSettings(): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.error(`Error: could not read ${SETTINGS_FILE}: ${(err as Error).message}`);
    return null;
  }
  try {
    // Strip a UTF-8 BOM (Windows editors add one; JSON.parse rejects it).
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error(`Error: ${SETTINGS_FILE} does not contain a JSON object.`);
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    console.error(`Error: ${SETTINGS_FILE} exists but is not valid JSON.`);
    console.error('Refusing to overwrite it — fix (or move) the file, then re-run.');
    return null;
  }
}

export function runInit(): void {
  const { statusCmd, hookCmd, mode } = detectMode();

  // Load existing settings — preserve whatever the user already has.
  const settings = loadSettings();
  if (settings === null) {
    process.exit(1);
  }

  settings.statusLine = { type: 'command', command: statusCmd };

  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const postHooks = Array.isArray(hooks[HOOK_EVENT]) ? (hooks[HOOK_EVENT] as unknown[]) : [];

  // Replace any existing codachi hook rather than duplicating.
  const cleaned = postHooks.filter((h) => !referencesCodachi(h));
  // No matcher key at all = match every tool (the documented match-all form).
  cleaned.push({ hooks: [{ type: 'command', command: hookCmd }] });
  hooks[HOOK_EVENT] = cleaned;

  // Migrate away from the legacy event name older versions registered under.
  if (Array.isArray(hooks[LEGACY_HOOK_EVENT])) {
    const remaining = (hooks[LEGACY_HOOK_EVENT] as unknown[]).filter((h) => !referencesCodachi(h));
    if (remaining.length === 0) delete hooks[LEGACY_HOOK_EVENT];
    else hooks[LEGACY_HOOK_EVENT] = remaining;
  }
  settings.hooks = hooks;

  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');

  console.log('codachi installed successfully!');
  console.log('');
  console.log(`  mode       ${mode === 'bin' ? 'bin (npx / global install)' : 'local clone (absolute paths)'}`);
  console.log(`  statusLine ${statusCmd}`);
  console.log(`  hook       ${hookCmd}`);
  console.log('');
  console.log('Restart Claude Code to see your pet hatch.');
  if (mode === 'bin') {
    console.log('Tip: `npx codachi stats` for a productivity summary.');
  }
}

export function runUninstall(): void {
  if (!fs.existsSync(SETTINGS_FILE)) {
    console.log('No settings file found — nothing to uninstall.');
    return;
  }

  const settings = loadSettings();
  if (settings === null) {
    process.exit(1);
  }

  let changed = false;

  // Remove statusLine if it references codachi.
  const sl = settings.statusLine as Record<string, unknown> | undefined;
  if (sl && typeof sl.command === 'string' && /codachi/.test(sl.command)) {
    delete settings.statusLine;
    changed = true;
  }

  // Remove codachi hooks — current event and the legacy one older versions used.
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (hooks) {
    for (const event of [HOOK_EVENT, LEGACY_HOOK_EVENT]) {
      const entries = hooks[event];
      if (!Array.isArray(entries)) continue;
      const remaining = entries.filter((h) => !referencesCodachi(h));
      if (remaining.length < entries.length) changed = true;
      if (remaining.length === 0) delete hooks[event];
      else hooks[event] = remaining;
    }
    if (Object.keys(hooks).length === 0) delete settings.hooks;
  }

  if (!changed) {
    console.log('codachi is not configured in settings — nothing to remove.');
    return;
  }

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
  console.log('codachi uninstalled from Claude Code settings.');
  console.log('Restart Claude Code to take effect.');
  console.log('');
  console.log('Note: pet data in ~/.claude/plugins/codachi/ is preserved.');
  console.log('Delete it manually if you want a clean break.');
}
