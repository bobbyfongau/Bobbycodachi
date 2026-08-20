import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import readline from 'node:readline';

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    statSync: vi.fn(),
    renameSync: vi.fn(),
    appendFileSync: vi.fn(),
  },
}));

vi.mock('node:readline', () => ({
  default: {
    createInterface: vi.fn(),
  },
}));

const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockCreateInterface = vi.mocked(readline.createInterface);

let runConfigure: typeof import('./configure.js')['runConfigure'];

/**
 * Feed a queue of answers to the wizard. Prompt order in runConfigure:
 *   name, animal, palette, showTokens, showVelocity, showGit
 */
function queueAnswers(answers: string[]) {
  mockCreateInterface.mockReturnValue({
    question: (_prompt: string, cb: (answer: string) => void) => cb(answers.shift() ?? ''),
    close: vi.fn(),
  } as any);
}

function savedConfig(): Record<string, unknown> {
  expect(mockWriteFileSync).toHaveBeenCalledTimes(1);
  return JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'clear').mockImplementation(() => {});
  const mod = await import('./configure.js');
  runConfigure = mod.runConfigure;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runConfigure', () => {
  it('pressing Enter at every prompt keeps the saved name, animal, and palette', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ name: 'Mochi', animal: 'cat', palette: 4 }));
    queueAnswers(['', '', '', '', '', '']);
    await runConfigure();
    const saved = savedConfig();
    expect(saved.name).toBe('Mochi');
    expect(saved.animal).toBe('cat');
    expect(saved.palette).toBe(4);
  });

  it('explicit random menu choices clear animal and palette', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ animal: 'cat', palette: 4 }));
    queueAnswers(['', '6', '11', '', '', '']);
    await runConfigure();
    const saved = savedConfig();
    expect(saved.animal).toBeUndefined();
    expect(saved.palette).toBeUndefined();
  });

  it('explicit selections override the existing values', async () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ animal: 'cat', palette: 4 }));
    queueAnswers(['Pip', '2', '7', '', '', '']);
    await runConfigure();
    const saved = savedConfig();
    expect(saved.name).toBe('Pip');
    expect(saved.animal).toBe('penguin');
    expect(saved.palette).toBe(7);
  });

  it('blank answers on a fresh config leave animal and palette unset (random)', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    queueAnswers(['', '', '', '', '', '']);
    await runConfigure();
    const saved = savedConfig();
    expect(saved.animal).toBeUndefined();
    expect(saved.palette).toBeUndefined();
  });
});
