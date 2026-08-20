import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// In-memory fake filesystem so we can simulate multiple statusline
// processes (vi.resetModules) sharing the same on-disk state.
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
      readdirSync: (dir: unknown) => {
        const prefix = String(dir).replace(/\/+$/, '') + '/';
        const names: string[] = [];
        for (const k of files.keys()) {
          if (k.startsWith(prefix) && !k.slice(prefix.length).includes('/')) {
            names.push(k.slice(prefix.length));
          }
        }
        return names;
      },
      unlinkSync: (p: unknown) => { files.delete(String(p)); },
      statSync: (p: unknown) => { throw enoent(String(p)); },
      appendFileSync: () => undefined,
    },
  };
});

vi.mock('node:fs', () => ({ default: fake.fs }));

const DIR = path.join(os.homedir(), '.claude', 'plugins', 'codachi');
const MEMORY_FILE = path.join(DIR, 'memory.json');
const keyFor = (src: string) => crypto.createHash('sha256').update(src).digest('hex').slice(0, 12);
const stateFileFor = (tp: string) => path.join(DIR, `state-${keyFor(tp)}.json`);
const eventsFileFor = (tp: string) => path.join(DIR, `events-${keyFor(tp)}.json`);
const DEFAULT_STATE_FILE = path.join(DIR, 'state-default.json');

function readFile(p: string): Record<string, unknown> {
  expect(fake.files.has(p), `expected file ${p} to exist`).toBe(true);
  return JSON.parse(fake.files.get(p)!) as Record<string, unknown>;
}
function readMemory(): Record<string, unknown> { return readFile(MEMORY_FILE); }

let mod: typeof import('./state.js');
let now = 1_750_000_000_000;

async function freshProcess(): Promise<typeof import('./state.js')> {
  vi.resetModules();
  return await import('./state.js');
}

beforeEach(async () => {
  fake.files.clear();
  vi.restoreAllMocks();
  now = 1_750_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  mod = await freshProcess();
});

describe('initSession — per-session state', () => {
  it('creates a per-session record on first run', () => {
    mod.initSession('/tmp/transcript1.jsonl');
    const state = readFile(stateFileFor('/tmp/transcript1.jsonl'));
    expect(state.version).toBe(1);
    expect(state.sessionStart).toBe(now);
    expect(mod.getSessionAnimalIndex()).toBeGreaterThanOrEqual(0);
    expect(mod.getSessionAnimalIndex()).toBeLessThan(5);
    expect((readMemory().totalSessions)).toBe(1);
  });

  it('two concurrent windows coexist without thrashing each other', async () => {
    mod.initSession('/tmp/a.jsonl');
    const aBefore = readFile(stateFileFor('/tmp/a.jsonl'));

    // Window B renders (separate process)
    mod = await freshProcess();
    now += 300;
    mod.initSession('/tmp/b.jsonl');

    // Window A renders again — must NOT be treated as a new session
    mod = await freshProcess();
    now += 300;
    mod.initSession('/tmp/a.jsonl');
    const aAfter = readFile(stateFileFor('/tmp/a.jsonl'));

    expect(readMemory().totalSessions).toBe(2); // one per real session, no inflation
    expect(aAfter.sessionStart).toBe(aBefore.sessionStart);
    expect(aAfter.animalIndex).toBe(aBefore.animalIndex); // no species flicker
    expect(aAfter.paletteIndex).toBe(aBefore.paletteIndex);
    expect(mod.getSessionAnimalIndex()).toBe(aBefore.animalIndex);
  });

  it('missing transcript_path reuses the stable fallback key instead of resetting every render', async () => {
    mod.initSession(undefined);
    const first = readFile(DEFAULT_STATE_FILE);
    for (let i = 0; i < 3; i++) {
      mod = await freshProcess();
      now += 300;
      mod.initSession(undefined);
    }
    const last = readFile(DEFAULT_STATE_FILE);
    expect(readMemory().totalSessions).toBe(1);
    expect(last.sessionStart).toBe(first.sessionStart);
    expect(last.animalIndex).toBe(first.animalIndex);
  });

  it('empty-string transcript_path behaves like missing (same fallback key)', async () => {
    mod.initSession('');
    mod = await freshProcess();
    now += 300;
    mod.initSession(undefined);
    expect(readMemory().totalSessions).toBe(1);
  });

  it('clears the (reused) session key events file on new session', () => {
    mod.initSession('/tmp/fresh.jsonl');
    const events = readFile(eventsFileFor('/tmp/fresh.jsonl'));
    expect(events.events).toEqual([]);
    expect(events.clearedAt).toBe(now);
  });
});

describe('uptime accounting', () => {
  it('counts rendered time (lastActive - sessionStart), never wall-clock between sessions', async () => {
    mod.initSession('/tmp/a.jsonl');
    now += 70_000;
    mod.recordContextPercent(10); // advances lastActive
    now += 60_000;
    mod.recordContextPercent(12); // lastActive = start + 130s

    // Four days idle, then a new session starts
    now += 4 * 24 * 3600_000;
    mod = await freshProcess();
    mod.initSession('/tmp/b.jsonl');

    const mem = readMemory();
    expect(mem.totalUptimeMin).toBe(2); // floor(130s / 60s), NOT ~5760
  });

  it('clamps uptime at 0 on clock skew (lastActive before sessionStart)', async () => {
    fake.files.set(stateFileFor('/tmp/skew.jsonl'), JSON.stringify({
      version: 1, transcriptPath: '/tmp/skew.jsonl',
      sessionStart: now, lastActive: now - 300_000,
    }));
    now += 3 * 24 * 3600_000;
    mod = await freshProcess();
    mod.initSession('/tmp/b.jsonl');
    expect(readMemory().totalUptimeMin).toBe(0);
  });

  it('does not double-count: swept span is watermarked', async () => {
    fake.files.set(stateFileFor('/tmp/w.jsonl'), JSON.stringify({
      version: 1, transcriptPath: '/tmp/w.jsonl',
      sessionStart: now - 3600_000, lastActive: now - 3000_000,
    }));
    mod.initSession('/tmp/b.jsonl'); // sweeps 10 min
    expect(readMemory().totalUptimeMin).toBe(10);

    mod = await freshProcess();
    now += 300_000;
    mod.initSession('/tmp/c.jsonl'); // second sweep must add nothing new
    expect(readMemory().totalUptimeMin).toBe(10);
  });

  it('prunes session records older than 7 days (counting their uptime first)', async () => {
    const oldStart = now - 8 * 24 * 3600_000;
    fake.files.set(stateFileFor('/tmp/old.jsonl'), JSON.stringify({
      version: 1, transcriptPath: '/tmp/old.jsonl',
      sessionStart: oldStart, lastActive: oldStart + 30 * 60_000,
    }));
    fake.files.set(eventsFileFor('/tmp/old.jsonl'), JSON.stringify({ events: [] }));

    mod.initSession('/tmp/new.jsonl');

    expect(fake.files.has(stateFileFor('/tmp/old.jsonl'))).toBe(false);
    expect(fake.files.has(eventsFileFor('/tmp/old.jsonl'))).toBe(false);
    expect(readMemory().totalUptimeMin).toBe(30);
  });

  it('skips sessions that look live in another window (fresh lastActive)', async () => {
    mod.initSession('/tmp/a.jsonl');
    mod = await freshProcess();
    now += 1000; // A is still fresh
    mod.initSession('/tmp/b.jsonl');
    expect(fake.files.has(stateFileFor('/tmp/a.jsonl'))).toBe(true);
    expect(readMemory().totalUptimeMin).toBe(0); // A not swept while live
  });
});

describe('sessionUptime', () => {
  it('returns <1m for very short sessions', () => {
    mod.initSession('/tmp/test-uptime.jsonl');
    expect(mod.sessionUptime()).toBe('<1m');
  });

  it('never goes negative on clock skew', () => {
    mod.initSession('/tmp/test-uptime.jsonl');
    now -= 3600_000;
    expect(mod.sessionUptime()).toBe('<1m');
  });
});

describe('sessionAgeTick', () => {
  it('is 0 at session start and grows with session age', () => {
    mod.initSession('/tmp/age.jsonl');
    expect(mod.sessionAgeTick()).toBe(0);
    now += 25_000;
    expect(mod.sessionAgeTick()).toBe(2);
  });

  it('is huge when no session is initialized (welcome gate never fires)', () => {
    expect(mod.sessionAgeTick()).toBeGreaterThan(1_000_000);
  });
});

describe('animTick', () => {
  it('returns integer based on time', () => {
    const tick = mod.animTick(1.5);
    expect(Number.isInteger(tick)).toBe(true);
    expect(tick).toBeGreaterThan(0);
  });

  it('changes with different speeds', () => {
    const fast = mod.animTick(0.5);
    const slow = mod.animTick(5.0);
    expect(fast).toBeGreaterThanOrEqual(slow);
  });
});

describe('moodTick', () => {
  it('returns integer', () => {
    expect(Number.isInteger(mod.moodTick())).toBe(true);
  });
});

describe('context velocity', () => {
  it('returns 0 with insufficient data', () => {
    expect(mod.getContextVelocity()).toBe(0);
  });

  it('returns 0 after single recording', () => {
    mod.initSession('/tmp/vel.jsonl');
    mod.recordContextPercent(50);
    expect(mod.getContextVelocity()).toBe(0);
  });

  it('survives process restarts: samples persist in the session state', async () => {
    mod.initSession('/tmp/vel.jsonl');
    mod.recordContextPercent(10);

    // Next render is a brand-new process
    mod = await freshProcess();
    now += 30_000;
    mod.initSession('/tmp/vel.jsonl');
    mod.recordContextPercent(40);

    expect(mod.getContextVelocity()).toBe(60); // 30% over 0.5min
    expect(mod.getContextTimeRemaining(40)).toBe('~1m');
  });

  it('does not mix samples across different sessions', async () => {
    mod.initSession('/tmp/vel-a.jsonl');
    mod.recordContextPercent(10);

    mod = await freshProcess();
    now += 30_000;
    mod.initSession('/tmp/vel-b.jsonl');
    mod.recordContextPercent(90);
    expect(mod.getContextVelocity()).toBe(0); // only one sample for B
  });

  it('recovers when the clock goes backwards', () => {
    mod.initSession('/tmp/vel.jsonl');
    mod.recordContextPercent(10);
    now -= 60_000;
    mod.recordContextPercent(20); // resets stale future samples
    expect(mod.getContextVelocity()).toBe(0);
  });
});

describe('state validation (migrateState)', () => {
  it('resets corrupt indices instead of blanking the render', () => {
    fake.files.set(stateFileFor('/tmp/corrupt.jsonl'), JSON.stringify({
      version: 1, transcriptPath: '/tmp/corrupt.jsonl',
      sessionStart: now - 60_000, animalIndex: -3, paletteIndex: 'nope',
    }));
    mod.initSession('/tmp/corrupt.jsonl');
    expect(mod.getSessionAnimalIndex()).toBe(0);
    expect(mod.getSessionPaletteIndex()).toBe(0);
    // Still the same session — corrupt fields must not fake a new session
    expect(fake.files.has(MEMORY_FILE)).toBe(false);
  });

  it('treats insane sessionStart (far future) as absent', () => {
    fake.files.set(stateFileFor('/tmp/future.jsonl'), JSON.stringify({
      version: 1, transcriptPath: '/tmp/future.jsonl',
      sessionStart: now + 10 * 86400_000, animalIndex: 2,
    }));
    mod.initSession('/tmp/future.jsonl');
    const state = readFile(stateFileFor('/tmp/future.jsonl'));
    expect(state.sessionStart).toBe(now); // re-created sanely
  });

  it('drops malformed ctxHistory entries', () => {
    fake.files.set(stateFileFor('/tmp/hist.jsonl'), JSON.stringify({
      version: 1, transcriptPath: '/tmp/hist.jsonl', sessionStart: now - 60_000,
      ctxHistory: [{ pct: 10, t: now - 20_000 }, 'garbage', { pct: 'x' }, null],
    }));
    mod.initSession('/tmp/hist.jsonl');
    mod.recordContextPercent(20);
    expect(mod.getContextVelocity()).toBe(30); // 10% over 20s using the one valid sample
  });

  it('migrates pre-version state files (version: undefined)', () => {
    fake.files.set(stateFileFor('/tmp/old.jsonl'), JSON.stringify({
      transcriptPath: '/tmp/old.jsonl',
      sessionStart: now - 60_000,
      animalIndex: 2,
      paletteIndex: 5,
    }));
    mod.initSession('/tmp/old.jsonl');
    expect(mod.getSessionAnimalIndex()).toBe(2);
    expect(mod.getSessionPaletteIndex()).toBe(5);
  });

  it('keeps a newer-version state file intact (no silent downgrade)', () => {
    fake.files.set(stateFileFor('/tmp/v999.jsonl'), JSON.stringify({
      version: 999, transcriptPath: '/tmp/v999.jsonl',
      sessionStart: now - 60_000, animalIndex: 4, paletteIndex: 9,
      futureField: 'from-the-future',
    }));
    mod.initSession('/tmp/v999.jsonl');
    expect(mod.getSessionAnimalIndex()).toBe(4); // fields honored, not reset

    now += 70_000;
    mod.recordContextPercent(10); // triggers a rewrite
    const state = readFile(stateFileFor('/tmp/v999.jsonl'));
    expect(state.version).toBe(999);
    expect(state.futureField).toBe('from-the-future');
  });
});

describe('getRelationshipTier', () => {
  it('returns stranger for 0 sessions', () => {
    expect(mod.getRelationshipTier()).toBe('stranger');
  });

  it.each([
    [5, 'acquaintance'],
    [20, 'friend'],
    [50, 'bestie'],
  ])('returns correct tier for %i sessions', async (sessions, tier) => {
    fake.files.set(MEMORY_FILE, JSON.stringify({
      totalSessions: sessions, totalUptimeMin: 100, firstMet: now, lastSeen: now,
    }));
    mod = await freshProcess();
    expect(mod.getRelationshipTier()).toBe(tier);
  });
});

describe('getMemory', () => {
  it('returns default memory when no file', () => {
    const mem = mod.getMemory();
    expect(mem.totalSessions).toBe(0);
    expect(mem.totalUptimeMin).toBe(0);
    expect(mem.firstMet).toBeGreaterThan(0);
    expect(mem.lastSeen).toBeGreaterThan(0);
  });

  it('loads existing memory', async () => {
    fake.files.set(MEMORY_FILE, JSON.stringify({
      totalSessions: 10, totalUptimeMin: 200, firstMet: 1000, lastSeen: 2000,
    }));
    mod = await freshProcess();
    const mem = mod.getMemory();
    expect(mem.totalSessions).toBe(10);
    expect(mem.totalUptimeMin).toBe(200);
  });
});

describe('memory forward compatibility', () => {
  it('preserves unknown fields and the newer version stamp on rewrite', () => {
    fake.files.set(MEMORY_FILE, JSON.stringify({
      version: 3, totalSessions: 5, totalUptimeMin: 10,
      firstMet: 1000, lastSeen: 2000,
      streaks: { best: 4 }, // future-schema field
    }));
    mod.initSession('/tmp/n.jsonl'); // updateMemory rewrites memory.json
    const mem = readMemory();
    expect(mem.version).toBe(3); // NOT stamped back down to 1
    expect(mem.streaks).toEqual({ best: 4 }); // future data survives
    expect(mem.totalSessions).toBe(6);
  });

  it('clamps negative totalSessions to 0', async () => {
    fake.files.set(MEMORY_FILE, JSON.stringify({
      totalSessions: -5, totalUptimeMin: -100, firstMet: 0, lastSeen: 0,
    }));
    mod = await freshProcess();
    const mem = mod.getMemory();
    expect(mem.totalSessions).toBe(0);
    expect(mem.totalUptimeMin).toBe(0);
  });

  it('handles NaN in memory gracefully', async () => {
    fake.files.set(MEMORY_FILE, JSON.stringify({
      totalSessions: 'not a number', totalUptimeMin: null, firstMet: 'bad', lastSeen: undefined,
    }));
    mod = await freshProcess();
    const mem = mod.getMemory();
    expect(mem.totalSessions).toBe(0);
    expect(mem.totalUptimeMin).toBe(0);
    expect(mem.firstMet).toBeGreaterThan(0);
    expect(mem.lastSeen).toBeGreaterThan(0);
  });

  it('preserves version stamp on loaded memory', async () => {
    fake.files.set(MEMORY_FILE, JSON.stringify({
      version: 1, totalSessions: 10, totalUptimeMin: 60, firstMet: 1000, lastSeen: 2000,
    }));
    mod = await freshProcess();
    expect(mod.getMemory().version).toBe(1);
  });
});

describe('context time remaining', () => {
  it('returns null with no velocity data', () => {
    expect(mod.getContextTimeRemaining(50)).toBeNull();
  });

  it('returns null when velocity is near zero', () => {
    mod.initSession('/tmp/ctr.jsonl');
    mod.recordContextPercent(50);
    expect(mod.getContextTimeRemaining(50)).toBeNull();
  });
});

describe('tier upgrade celebration window', () => {
  it('didTierUpgrade returns false by default', () => {
    expect(mod.didTierUpgrade()).toBe(false);
  });

  it('stays true for the celebration window (~30s), across processes, then expires', async () => {
    fake.files.set(MEMORY_FILE, JSON.stringify({
      totalSessions: 2, totalUptimeMin: 10, firstMet: 1000, lastSeen: 2000,
      lastShownTier: 'stranger',
    }));
    mod.initSession('/tmp/tier.jsonl'); // 3rd session → acquaintance
    expect(mod.didTierUpgrade()).toBe(true);

    // 10s later, a different render process — still celebrating
    mod = await freshProcess();
    now += 10_000;
    mod.initSession('/tmp/tier.jsonl');
    expect(mod.didTierUpgrade()).toBe(true);

    // 40s after the upgrade — window closed
    mod = await freshProcess();
    now += 30_000;
    mod.initSession('/tmp/tier.jsonl');
    expect(mod.didTierUpgrade()).toBe(false);
  });

  it('does not re-celebrate the same tier', async () => {
    fake.files.set(MEMORY_FILE, JSON.stringify({
      totalSessions: 5, totalUptimeMin: 10, firstMet: 1000, lastSeen: 2000,
      lastShownTier: 'acquaintance',
    }));
    mod.initSession('/tmp/tier2.jsonl');
    expect(mod.didTierUpgrade()).toBe(false);
  });
});
