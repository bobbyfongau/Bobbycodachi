import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { parseEvent, detectExitCode, extractFilePath, appendEvent } from './hook.js';
import type { CodachiEvent } from './hook.js';

// In-memory fake filesystem so appendEvent's read-modify-write (and its
// verify pass through atomicWrite/rename) runs end-to-end.
const fake = vi.hoisted(() => {
  const files = new Map<string, string>();
  const enoent = (p: string) => Object.assign(new Error('ENOENT: ' + p), { code: 'ENOENT' });
  return {
    files,
    fs: {
      readFileSync: (p: unknown) => {
        const k = String(p);
        if (!files.has(k)) throw enoent(k);
        return files.get(k)!;
      },
      writeFileSync: (p: unknown, d: unknown) => { files.set(String(p), String(d)); },
      renameSync: (a: unknown, b: unknown) => {
        const k = String(a);
        if (!files.has(k)) throw enoent(k);
        files.set(String(b), files.get(k)!);
        files.delete(k);
      },
      mkdirSync: () => undefined,
      readdirSync: () => [],
      unlinkSync: (p: unknown) => { files.delete(String(p)); },
      statSync: (p: unknown) => { throw enoent(String(p)); },
      appendFileSync: () => undefined,
    },
  };
});

vi.mock('node:fs', () => ({ default: fake.fs }));

const EVENTS_DIR = path.join(os.homedir(), '.claude', 'plugins', 'codachi');
const eventsFile = (key: string) => path.join(EVENTS_DIR, `events-${key}.json`);

function readEventsJSON(key: string): { events: CodachiEvent[]; totalCount?: number; totalEditCount?: number; clearedAt?: number } {
  expect(fake.files.has(eventsFile(key)), `expected ${eventsFile(key)} to exist`).toBe(true);
  return JSON.parse(fake.files.get(eventsFile(key))!);
}

beforeEach(() => { fake.files.clear(); });

describe('extractFilePath', () => {
  it('extracts file_path', () => {
    expect(extractFilePath({ file_path: '/tmp/foo.ts' })).toBe('/tmp/foo.ts');
  });

  it('extracts filePath (camelCase)', () => {
    expect(extractFilePath({ filePath: '/tmp/bar.ts' })).toBe('/tmp/bar.ts');
  });

  it('returns empty for missing path', () => {
    expect(extractFilePath({})).toBe('');
  });
});

describe('detectExitCode', () => {
  it('detects success from top-level exit_code', () => {
    expect(detectExitCode({ exit_code: 0 })).toBe(true);
    expect(detectExitCode({ exitCode: 0 })).toBe(true);
  });

  it('detects failure from top-level exit_code', () => {
    expect(detectExitCode({ exit_code: 1 })).toBe(false);
  });

  // tool_response is the field real Claude Code PostToolUse payloads carry
  it('detects from structured tool_response', () => {
    expect(detectExitCode({ tool_response: { exit_code: 0 } })).toBe(true);
    expect(detectExitCode({ tool_response: { exitCode: 2 } })).toBe(false);
  });

  it('detects failure from tool_response stdout/stderr text (Bash shape)', () => {
    expect(detectExitCode({
      tool_response: { stdout: '', stderr: 'npm ERR!\nExit code: 1', interrupted: false },
    })).toBe(false);
    expect(detectExitCode({
      tool_response: { stdout: 'done\nExit code: 0', stderr: '', interrupted: false },
    })).toBe(true);
  });

  it('treats an interrupted tool_response as failure', () => {
    expect(detectExitCode({ tool_response: { stdout: '', stderr: '', interrupted: true } })).toBe(false);
  });

  it('defaults to success for a clean tool_response with no exit info', () => {
    expect(detectExitCode({ tool_response: { stdout: 'all good', stderr: '', interrupted: false } })).toBe(true);
  });

  it('detects from string tool_response', () => {
    expect(detectExitCode({ tool_response: 'Error\nexit code: 1' })).toBe(false);
  });

  it('detects from structured tool_output (legacy fallback)', () => {
    expect(detectExitCode({ tool_output: { exit_code: 0 } })).toBe(true);
    expect(detectExitCode({ tool_output: { exitCode: 1 } })).toBe(false);
  });

  it('detects from string output (legacy fallback)', () => {
    expect(detectExitCode({ tool_output: 'Output\nExit code: 0' })).toBe(true);
    expect(detectExitCode({ tool_output: 'Error\nexit code: 1' })).toBe(false);
  });

  it('defaults to true for unknown format', () => {
    expect(detectExitCode({})).toBe(true);
    expect(detectExitCode({ tool_output: 'some output' })).toBe(true);
  });
});

describe('parseEvent', () => {
  it('parses bash command', () => {
    const event = parseEvent({ tool_name: 'Bash', tool_input: { command: 'npm test' }, exit_code: 0 });
    expect(event).toEqual({ type: 'bash', detail: 'npm test', ok: true, ts: expect.any(Number) });
  });

  it('parses a failing bash command from a real tool_response payload', () => {
    const event = parseEvent({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: '', stderr: '1 failing\nExit code: 1', interrupted: false },
    });
    expect(event?.ok).toBe(false);
  });

  it('parses edit event', () => {
    const event = parseEvent({ tool_name: 'Edit', tool_input: { file_path: '/tmp/src/foo.ts' } });
    expect(event).toEqual({ type: 'edit', detail: 'foo.ts', ok: true, ts: expect.any(Number) });
  });

  it('parses write event', () => {
    const event = parseEvent({ tool_name: 'Write', tool_input: { file_path: '/tmp/bar.ts' } });
    expect(event?.type).toBe('write');
    expect(event?.detail).toBe('bar.ts');
  });

  it('parses read event', () => {
    const event = parseEvent({ tool_name: 'Read', tool_input: { file_path: '/tmp/baz.ts' } });
    expect(event?.type).toBe('read');
    expect(event?.detail).toBe('baz.ts');
  });

  it('returns null for empty tool name', () => {
    expect(parseEvent({ tool_input: {} })).toBeNull();
  });

  it('returns null for bash with no command', () => {
    expect(parseEvent({ tool_name: 'Bash', tool_input: {} })).toBeNull();
  });

  it('returns null for edit with no file path', () => {
    expect(parseEvent({ tool_name: 'Edit', tool_input: {} })).toBeNull();
  });

  it('classifies Grep as search', () => {
    const event = parseEvent({ tool_name: 'Grep', tool_input: { pattern: 'TODO' } });
    expect(event?.type).toBe('search');
    expect(event?.detail).toBe('TODO');
  });

  it('classifies Glob as search', () => {
    const event = parseEvent({ tool_name: 'Glob', tool_input: { pattern: '**/*.ts' } });
    expect(event?.type).toBe('search');
    expect(event?.detail).toBe('**/*.ts');
  });

  it('classifies Agent as agent', () => {
    const event = parseEvent({ tool_name: 'Agent', tool_input: { description: 'find bugs' } });
    expect(event?.type).toBe('agent');
    expect(event?.detail).toBe('find bugs');
  });

  it('classifies WebSearch as web', () => {
    const event = parseEvent({ tool_name: 'WebSearch', tool_input: { query: 'npm publish' } });
    expect(event?.type).toBe('web');
    expect(event?.detail).toBe('npm publish');
  });

  it('classifies LSP as lsp', () => {
    const event = parseEvent({ tool_name: 'LSP', tool_input: { action: 'references' } });
    expect(event?.type).toBe('lsp');
    expect(event?.detail).toBe('references');
  });

  it('handles truly unknown tool types as other', () => {
    const event = parseEvent({ tool_name: 'SomeNewTool', tool_input: {} });
    expect(event?.type).toBe('other');
    expect(event?.detail).toBe('somenewtool');
  });

  it('truncates long bash commands to 300 chars', () => {
    const longCmd = 'x'.repeat(500);
    const event = parseEvent({ tool_name: 'Bash', tool_input: { command: longCmd } });
    expect(event?.detail.length).toBe(300);
  });

  it('is case-insensitive for tool names', () => {
    const event = parseEvent({ tool_name: 'BASH', tool_input: { command: 'ls' } });
    expect(event?.type).toBe('bash');
  });
});

describe('appendEvent', () => {
  it('appends to existing events and bumps the monotonic counters', () => {
    fake.files.set(eventsFile('default'), JSON.stringify({
      events: [{ type: 'read', detail: 'a.ts', ok: true, ts: 1 }],
      totalCount: 1, totalEditCount: 0,
    }));

    appendEvent({ type: 'bash', detail: 'npm test', ok: true, ts: 2 });

    const written = readEventsJSON('default');
    expect(written.events.map(e => e.detail)).toEqual(['a.ts', 'npm test']);
    expect(written.totalCount).toBe(2);
    expect(written.totalEditCount).toBe(0);
  });

  it('counts edits and writes in totalEditCount', () => {
    appendEvent({ type: 'edit', detail: 'a.ts', ok: true, ts: 1 });
    appendEvent({ type: 'write', detail: 'b.ts', ok: true, ts: 2 });
    appendEvent({ type: 'bash', detail: 'ls', ok: true, ts: 3 });

    const written = readEventsJSON('default');
    expect(written.totalCount).toBe(3);
    expect(written.totalEditCount).toBe(2);
  });

  it('writes to the per-session file for the given key', () => {
    appendEvent({ type: 'bash', detail: 'ls', ok: true, ts: 1 }, 'abc123');
    expect(fake.files.has(eventsFile('abc123'))).toBe(true);
    expect(fake.files.has(eventsFile('default'))).toBe(false);
  });

  it('limits stored events to 50 while counters keep growing', () => {
    const events = Array.from({ length: 55 }, (_, i) => ({
      type: 'bash', detail: `cmd${i}`, ok: true, ts: i + 1,
    }));
    fake.files.set(eventsFile('default'), JSON.stringify({ events, totalCount: 60 }));

    appendEvent({ type: 'bash', detail: 'new', ok: true, ts: 100 });

    const written = readEventsJSON('default');
    expect(written.events.length).toBeLessThanOrEqual(50);
    expect(written.events[written.events.length - 1].detail).toBe('new');
    expect(written.totalCount).toBe(61);
  });

  it('preserves clearedAt and never resurrects pre-clear events', () => {
    fake.files.set(eventsFile('default'), JSON.stringify({
      events: [{ type: 'bash', detail: 'stale', ok: false, ts: 500 }],
      totalCount: 50, totalEditCount: 10,
      clearedAt: 1000, // cleared AFTER those events were written
    }));

    appendEvent({ type: 'bash', detail: 'fresh', ok: true, ts: 2000 });

    const written = readEventsJSON('default');
    expect(written.clearedAt).toBe(1000);
    expect(written.events.map(e => e.detail)).toEqual(['fresh']); // stale dropped
    expect(written.totalCount).toBe(51);
  });

  it('creates the file when none exists', () => {
    appendEvent({ type: 'bash', detail: 'ls', ok: true, ts: 1 });
    const written = readEventsJSON('default');
    expect(written.events).toHaveLength(1);
    expect(written.totalCount).toBe(1);
  });
});
