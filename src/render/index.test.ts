import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, truncate } from './index.js';
import { stringWidth } from '../width.js';
import type { EventContext } from '../events.js';

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const noEvent: EventContext = {
  category: null, freshness: 'none', detail: '',
  consecutiveFailures: 0, sessionEditCount: 0, sessionActionCount: 0,
};

function makeRenderInput(overrides: Record<string, unknown> = {}) {
  return {
    contextPercent: 50,
    modelName: 'Opus 4.6',
    animalType: 'cat' as const,
    colors: {
      body: '\x1b[38;2;255;127;80m',
      accent: '\x1b[38;2;255;99;71m',
      face: '\x1b[38;2;255;200;150m',
      blush: '\x1b[38;2;255;160;122m',
    },
    git: null,
    fiveHourUsage: null as import('../stdin.js').RateLimitInfo | null,
    sevenDayUsage: null as import('../stdin.js').RateLimitInfo | null,
    sessionCost: null,
    contextVelocity: 0,
    tokenSummary: null,
    relationshipTier: 'stranger' as const,
    sessionNumber: 1,
    animTick: 0,
    moodTick: 5,
    eventContext: noEvent,
    petName: 'Cat',
    contextTimeRemaining: null,
    tierUpgraded: false,
    ...overrides,
  };
}

let logOutput: string[];

beforeEach(() => {
  logOutput = [];
  vi.spyOn(console, 'log').mockImplementation((msg: string) => {
    logOutput.push(msg);
  });
});

describe('render', () => {
  it('outputs exactly 3 lines', () => {
    render(makeRenderInput());
    expect(logOutput).toHaveLength(3);
  });

  it('includes model name in line 1', () => {
    render(makeRenderInput());
    expect(logOutput[0]).toContain('Opus 4.6');
  });

  it('includes context percentage in line 1', () => {
    render(makeRenderInput({ contextPercent: 75 }));
    expect(logOutput[0]).toContain('75%');
  });

  it('shows git branch in line 2 when git data present', () => {
    render(makeRenderInput({
      git: {
        branch: 'main', isDirty: true, ahead: 0, behind: 0,
        modified: 2, added: 0, deleted: 0, untracked: 0,
        insertions: 0, deletions: 0, fileCount: 2,
        lastCommit: 'test commit', stashCount: 0, dominantFileType: null,
      },
    }));
    expect(logOutput[1]).toContain('main');
  });

  it('shows "(no git repo)" when no git data', () => {
    render(makeRenderInput());
    expect(logOutput[1]).toContain('no git repo');
  });

  it('includes animal name in line 3', () => {
    render(makeRenderInput());
    expect(logOutput[2]).toContain('Cat');
  });

  it('line 3 is pet name + mood only', () => {
    render(makeRenderInput());
    // Line 3 should contain pet name but NOT project/uptime clutter
    expect(logOutput[2]).toContain('Cat');
    expect(logOutput[2]).not.toContain('myapp');
    expect(logOutput[2]).not.toContain('[Node]');
  });

  it('shows token summary when provided', () => {
    render(makeRenderInput({ tokenSummary: '550K/1.0M' }));
    expect(logOutput[0]).toContain('550K/1.0M');
  });

  it('shows velocity when > 0.5', () => {
    render(makeRenderInput({ contextVelocity: 3 }));
    expect(logOutput[0]).toContain('^3%/m');
  });

  it('shows five hour usage bar', () => {
    render(makeRenderInput({
      fiveHourUsage: { percent: 40, resetsIn: '2h30m', paceDelta: 5 },
    }));
    expect(logOutput[0]).toContain('5h');
    expect(logOutput[0]).toContain('40%');
    expect(logOutput[0]).toContain('~2h30m');
  });

  it('shows seven day usage when provided', () => {
    render(makeRenderInput({
      sevenDayUsage: { percent: 50, resetsIn: '3d', paceDelta: -3 },
    }));
    expect(logOutput[0]).toContain('7d');
    expect(logOutput[0]).toContain('50%');
  });

  it('shows seven day usage even at low percentages', () => {
    render(makeRenderInput({
      sevenDayUsage: { percent: 5, resetsIn: '6d', paceDelta: null },
    }));
    expect(logOutput[0]).toContain('7d');
    expect(logOutput[0]).toContain('5%');
  });

  it('shows git insertions/deletions', () => {
    render(makeRenderInput({
      git: {
        branch: 'main', isDirty: true, ahead: 0, behind: 0,
        modified: 0, added: 0, deleted: 0, untracked: 0,
        insertions: 100, deletions: 50, fileCount: 0,
        lastCommit: '', stashCount: 0, dominantFileType: null,
      },
    }));
    expect(logOutput[1]).toContain('+100');
    expect(logOutput[1]).toContain('-50');
  });

  it('shows git ahead/behind', () => {
    render(makeRenderInput({
      git: {
        branch: 'feat', isDirty: false, ahead: 3, behind: 1,
        modified: 0, added: 0, deleted: 0, untracked: 0,
        insertions: 0, deletions: 0, fileCount: 0,
        lastCommit: '', stashCount: 0, dominantFileType: null,
      },
    }));
    expect(logOutput[1]).toContain('up3');
    expect(logOutput[1]).toContain('dn1');
  });

  it('shows stash count', () => {
    render(makeRenderInput({
      git: {
        branch: 'main', isDirty: false, ahead: 0, behind: 0,
        modified: 0, added: 0, deleted: 0, untracked: 0,
        insertions: 0, deletions: 0, fileCount: 0,
        lastCommit: '', stashCount: 3, dominantFileType: null,
      },
    }));
    expect(logOutput[1]).toContain('stash:3');
  });

  it('does not show language tag on line 3', () => {
    render(makeRenderInput());
    expect(logOutput[2]).not.toContain('[Node]');
  });

  it('never emits lone surrogates when git last commit has emoji', () => {
    render(makeRenderInput({
      git: {
        branch: 'main', isDirty: false, ahead: 0, behind: 0,
        modified: 0, added: 0, deleted: 0, untracked: 0,
        insertions: 0, deletions: 0, fileCount: 0,
        lastCommit: '🎉 initial release with a fairly long message', stashCount: 0,
        dominantFileType: null,
      },
    }));
    for (const line of logOutput) {
      expect(line).not.toMatch(LONE_SURROGATE);
    }
  });

  it('emits zero escape bytes when NO_COLOR is set', async () => {
    process.env.NO_COLOR = '1';
    vi.resetModules();
    const mod = await import('./index.js');
    mod.render(makeRenderInput({
      colors: { body: '', accent: '', face: '', blush: '' },
      git: {
        branch: 'main', isDirty: true, ahead: 1, behind: 0,
        modified: 2, added: 1, deleted: 0, untracked: 3,
        insertions: 10, deletions: 5, fileCount: 3,
        lastCommit: 'test commit', stashCount: 1, dominantFileType: null,
      },
    }));
    expect(logOutput.length).toBeGreaterThan(0);
    for (const line of logOutput) {
      expect(line).not.toContain('\x1b');
    }
    delete process.env.NO_COLOR;
    vi.resetModules();
  });
});

describe('truncate', () => {
  it('returns strings that fit unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('exactly10!', 10)).toBe('exactly10!');
  });

  it('truncates to maxWidth with ellipsis', () => {
    const out = stripAnsi(truncate('hello wonderful world', 10));
    expect(out).toBe('hello w...');
    expect(stringWidth(out)).toBeLessThanOrEqual(10);
  });

  it('never splits a surrogate pair', () => {
    // Cut lands with exactly one column of room before the emoji.
    const out = truncate('last: ab🎉 initial commit message', 12);
    expect(out).not.toMatch(LONE_SURROGATE);
    expect(stripAnsi(out)).toBe('last: ab...');
    expect(stringWidth(out)).toBeLessThanOrEqual(12);
  });

  it('never splits a ZWJ sequence', () => {
    const out = truncate('name: 👩‍💻 coding away happily', 9);
    expect(out).not.toMatch(LONE_SURROGATE);
    expect(stripAnsi(out)).toBe('name: ...');
  });

  it('keeps whole emoji when there is room for them', () => {
    const out = stripAnsi(truncate('a🎉🎉🎉🎉🎉', 8));
    expect(out).toBe('a🎉🎉...');
    expect(stringWidth(out)).toBeLessThanOrEqual(8);
  });

  it('preserves ANSI escapes without counting them', () => {
    const colored = '\x1b[38;2;255;0;0mred and quite long text\x1b[0m';
    const out = truncate(colored, 10);
    expect(out).toContain('\x1b[38;2;255;0;0m');
    expect(stringWidth(out)).toBeLessThanOrEqual(10);
    expect(stripAnsi(out)).toBe('red and...');
  });
});
