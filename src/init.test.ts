import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runInit, runUninstall, SETTINGS_FILE } from './init.js';

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn(),
  },
}));

const originalArgv1 = process.argv[1];

function enoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

/** Force detectMode into 'bin' mode so tests don't depend on the local dist/. */
function useBinMode(): void {
  process.argv[1] = ['', 'fake', 'node_modules', '.bin', 'codachi'].join(path.sep);
}

function writtenSettings(): Record<string, unknown> {
  const calls = vi.mocked(fs.writeFileSync).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [file, content] = calls[calls.length - 1];
  expect(file).toBe(SETTINGS_FILE);
  return JSON.parse(content as string) as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetAllMocks();
  useBinMode();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
});

afterEach(() => {
  process.argv[1] = originalArgv1;
  vi.restoreAllMocks();
});

describe('runInit', () => {
  it('creates settings with a PostToolUse hook in the nested schema when no file exists', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw enoent(); });

    runInit();

    const settings = writtenSettings();
    expect(settings.statusLine).toEqual({ type: 'command', command: 'codachi' });
    const hooks = settings.hooks as Record<string, unknown>;
    expect(hooks.PostToolExecution).toBeUndefined();
    expect(hooks.PostToolUse).toEqual([
      { hooks: [{ type: 'command', command: 'codachi-hook' }] },
    ]);
  });

  it('preserves existing settings and other hooks', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool' }] }],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'ding' }] }],
      },
    }));

    runInit();

    const settings = writtenSettings();
    expect(settings.env).toEqual({ FOO: 'bar' });
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.PostToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool' }] },
      { hooks: [{ type: 'command', command: 'codachi-hook' }] },
    ]);
  });

  it('is idempotent — replaces an existing codachi PostToolUse entry instead of duplicating', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'node "/old/codachi/dist/hook.js"' }] }],
      },
    }));

    runInit();

    const hooks = (writtenSettings().hooks as Record<string, unknown>);
    expect(hooks.PostToolUse).toEqual([
      { hooks: [{ type: 'command', command: 'codachi-hook' }] },
    ]);
  });

  it('migrates a legacy flat PostToolExecution codachi entry to PostToolUse', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      hooks: {
        PostToolExecution: [
          { matcher: '', command: 'codachi-hook' },
          { matcher: '', command: 'unrelated-tool' },
        ],
      },
    }));

    runInit();

    const hooks = writtenSettings().hooks as Record<string, unknown>;
    // codachi entry removed from the legacy event; unrelated entry preserved.
    expect(hooks.PostToolExecution).toEqual([{ matcher: '', command: 'unrelated-tool' }]);
    expect(hooks.PostToolUse).toEqual([
      { hooks: [{ type: 'command', command: 'codachi-hook' }] },
    ]);
  });

  it('drops the legacy PostToolExecution key entirely when only codachi lived there', () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      hooks: { PostToolExecution: [{ matcher: '', command: 'codachi-hook' }] },
    }));

    runInit();

    const hooks = writtenSettings().hooks as Record<string, unknown>;
    expect(hooks.PostToolExecution).toBeUndefined();
    expect(hooks.PostToolUse).toHaveLength(1);
  });

  it('aborts without writing when settings.json exists but is invalid JSON', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('{ "statusLine": { , }');

    expect(() => runInit()).toThrow('process.exit(1)');

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'));
  });

  it('aborts without writing when settings.json is valid JSON but not an object', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('[1, 2, 3]');

    expect(() => runInit()).toThrow('process.exit(1)');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('aborts without writing on a non-ENOENT read error', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });

    expect(() => runInit()).toThrow('process.exit(1)');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('tolerates a UTF-8 BOM in an otherwise valid settings.json', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('\uFEFF' + JSON.stringify({ env: { KEEP: '1' } }));

    runInit();

    const settings = writtenSettings();
    expect(settings.env).toEqual({ KEEP: '1' });
  });

  it('writes quoted, decoded absolute paths in local-clone mode', () => {
    process.argv[1] = '/some/clone/dist/index.js'; // no node_modules → local mode
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw enoent(); });

    runInit();

    const settings = writtenSettings();
    const statusCmd = (settings.statusLine as Record<string, string>).command;
    const hookEntry = (settings.hooks as Record<string, unknown[]>).PostToolUse[0] as {
      hooks: Array<{ command: string }>;
    };
    const hookCmd = hookEntry.hooks[0].command;
    // Quoted so paths with spaces survive shell splitting.
    expect(statusCmd).toMatch(/^node ".+index\.js"$/);
    expect(hookCmd).toMatch(/^node ".+hook\.js"$/);
    // fileURLToPath, not URL.pathname — no percent-encoding artifacts.
    expect(statusCmd).not.toContain('%');
    expect(hookCmd).not.toContain('%');
  });
});

describe('runUninstall', () => {
  it('reports nothing to do when no settings file exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    runUninstall();

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('No settings file found — nothing to uninstall.');
  });

  it('aborts without writing when settings.json is unparseable', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not json at all');

    expect(() => runUninstall()).toThrow('process.exit(1)');
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('removes the codachi statusLine and nested PostToolUse hook', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      statusLine: { type: 'command', command: 'codachi' },
      hooks: {
        PostToolUse: [
          { hooks: [{ type: 'command', command: 'codachi-hook' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool' }] },
        ],
      },
      env: { KEEP: '1' },
    }));

    runUninstall();

    const settings = writtenSettings();
    expect(settings.statusLine).toBeUndefined();
    expect(settings.env).toEqual({ KEEP: '1' });
    expect((settings.hooks as Record<string, unknown>).PostToolUse).toEqual([
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool' }] },
    ]);
  });

  it('also removes legacy flat PostToolExecution codachi entries', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      hooks: { PostToolExecution: [{ matcher: '', command: 'codachi-hook' }] },
    }));

    runUninstall();

    const settings = writtenSettings();
    expect(settings.hooks).toBeUndefined();
  });

  it('does not write when nothing references codachi', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      statusLine: { type: 'command', command: 'some-other-statusline' },
    }));

    runUninstall();

    expect(fs.writeFileSync).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('codachi is not configured in settings — nothing to remove.');
  });
});
