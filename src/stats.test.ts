import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';

process.env.FORCE_COLOR = '3';

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    statSync: vi.fn(() => { throw new Error('ENOENT'); }),
    appendFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

const mockReadFileSync = vi.mocked(fs.readFileSync);
let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('runStats', () => {
  it('prints no-data message when no memory file exists', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    vi.resetModules();
    const { runStats } = await import('./stats.js');
    runStats();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('No codachi memory'));
  });

  it('prints stats when memory exists', async () => {
    const callNum: Record<string, number> = {};
    mockReadFileSync.mockImplementation((p: any) => {
      const file = String(p);
      callNum[file] = (callNum[file] || 0) + 1;
      if (file.includes('memory.json')) {
        return JSON.stringify({
          totalSessions: 25,
          totalUptimeMin: 600,
          firstMet: Date.now() - 30 * 86400_000,
          lastSeen: Date.now() - 3600_000,
        });
      }
      if (file.includes('state.json')) {
        return JSON.stringify({
          animalIndex: 0,
          paletteIndex: 0,
          sessionStart: Date.now() - 3600_000,
        });
      }
      if (file.includes('events.json')) {
        return JSON.stringify({ events: [
          { type: 'bash', detail: 'vitest run', ok: true, ts: Date.now() - 1000 },
          { type: 'bash', detail: 'vitest run', ok: false, ts: Date.now() - 2000 },
          { type: 'bash', detail: 'git commit -m "fix auth"', ok: true, ts: Date.now() - 3000 },
          { type: 'edit', detail: 'foo.ts', ok: true, ts: Date.now() - 4000 },
        ] });
      }
      if (file.includes('config.json')) {
        throw new Error('ENOENT');
      }
      throw new Error('ENOENT');
    });
    vi.resetModules();
    const { runStats } = await import('./stats.js');
    runStats();
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('25');          // sessions
    expect(output).toContain('friend');      // tier for 25 sessions
    expect(output).toContain('10h');         // 600min uptime
    expect(output).toContain('1 pass');      // test pass count
    expect(output).toContain('1 fail');      // test fail count
  });

  it('correctly computes relationship tier progress', async () => {
    mockReadFileSync.mockImplementation((p: any) => {
      if (String(p).includes('memory.json')) {
        return JSON.stringify({
          totalSessions: 3,
          totalUptimeMin: 30,
          firstMet: Date.now() - 86400_000,
          lastSeen: Date.now(),
        });
      }
      throw new Error('ENOENT');
    });
    vi.resetModules();
    const { runStats } = await import('./stats.js');
    runStats();
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('acquaintance');
    expect(output).toContain('friend');       // next tier
    expect(output).toContain('12 more');      // 15 - 3 = 12
  });

  it('renders first met / last seen in LOCAL time, not UTC', async () => {
    // 00:30 local on a fixed calendar day: in any UTC+ timezone the UTC date
    // is the PREVIOUS day, so toISOString-based formatting would regress.
    const firstMet = new Date(2026, 0, 15, 0, 30).getTime();
    const localDate = '2026-01-15';
    mockReadFileSync.mockImplementation((p: any) => {
      if (String(p).includes('memory.json')) {
        return JSON.stringify({
          totalSessions: 5, totalUptimeMin: 60,
          firstMet, lastSeen: firstMet,
        });
      }
      throw new Error('ENOENT');
    });
    vi.resetModules();
    const { runStats } = await import('./stats.js');
    runStats();
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain(localDate);
    const utcDate = new Date(firstMet).toISOString().slice(0, 10);
    if (utcDate !== localDate) {
      expect(output).not.toContain(utcDate);
    }
  });

  it('reads per-session state and event files, honoring clearedAt', async () => {
    const now = Date.now();
    vi.mocked(fs.readdirSync).mockReturnValue(
      ['state-abc.json', 'events-abc.json', 'memory.json'] as any,
    );
    mockReadFileSync.mockImplementation((p: any) => {
      const file = String(p);
      if (file.includes('memory.json')) {
        return JSON.stringify({
          totalSessions: 25, totalUptimeMin: 600,
          firstMet: now - 30 * 86400_000, lastSeen: now - 3600_000,
        });
      }
      if (file.includes('state-abc.json')) {
        return JSON.stringify({
          animalIndex: 1, paletteIndex: 0,
          sessionStart: now - 3 * 3600_000,
          lastActive: now - 3 * 3600_000 + 30 * 60_000, // rendered for 30m
        });
      }
      if (file.includes('events-abc.json')) {
        return JSON.stringify({
          clearedAt: now - 10_000,
          events: [
            { type: 'bash', detail: 'vitest run', ok: false, ts: now - 20_000 }, // pre-clear: ignored
            { type: 'bash', detail: 'vitest run', ok: true, ts: now - 1000 },
            { type: 'edit', detail: 'foo.ts', ok: true, ts: now - 500 },
          ],
        });
      }
      throw new Error('ENOENT');
    });
    vi.resetModules();
    const { runStats } = await import('./stats.js');
    runStats();
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('penguin');       // animalIndex 1 from session file
    expect(output).toContain('30m');           // this session = lastActive - sessionStart, not 3h
    expect(output).toContain('1 pass');        // post-clear test run counted
    expect(output).toContain('0 fail');        // pre-clear failure filtered out
  });

  it('shows max tier for bestie', async () => {
    mockReadFileSync.mockImplementation((p: any) => {
      if (String(p).includes('memory.json')) {
        return JSON.stringify({
          totalSessions: 100,
          totalUptimeMin: 5000,
          firstMet: Date.now() - 365 * 86400_000,
          lastSeen: Date.now(),
        });
      }
      throw new Error('ENOENT');
    });
    vi.resetModules();
    const { runStats } = await import('./stats.js');
    runStats();
    const output = consoleSpy.mock.calls.map(c => c[0]).join('\n');
    expect(output).toContain('bestie');
    expect(output).toContain('max tier');
  });
});
