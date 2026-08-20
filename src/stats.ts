/**
 * `codachi stats` — productivity summary pulled from local memory + events.
 *
 * Prints a human-readable digest of your relationship with your pet: sessions,
 * cumulative uptime, longest streak, relationship tier progress, and a quick
 * look at recent activity. No telemetry — everything is read from local JSON
 * in ~/.claude/plugins/codachi/.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, getConfig } from './config.js';
import { getAnimalName } from './animals/index.js';
import type { AnimalType } from './types.js';
import { COLOR_LEVEL, rgb, RESET, DIM } from './render/colors.js';

const STATE_DIR = path.join(os.homedir(), '.claude', 'plugins', 'codachi');
const MEMORY_FILE = path.join(STATE_DIR, 'memory.json');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const EVENTS_FILE = path.join(STATE_DIR, 'events.json');

interface Memory {
  totalSessions?: number;
  totalUptimeMin?: number;
  firstMet?: number;
  lastSeen?: number;
  lastShownTier?: string;
}
interface State {
  animalIndex?: number;
  paletteIndex?: number;
  sessionStart?: number;
  lastActive?: number;
  transcriptPath?: string;
}
interface Event { type: string; detail: string; ok: boolean; ts: number; }
interface EventsFile { events?: Event[]; clearedAt?: number; }

function readJSON<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch { return null; }
}

function listDataFiles(pattern: RegExp): string[] {
  try {
    return fs.readdirSync(STATE_DIR)
      .filter(n => pattern.test(n))
      .map(n => path.join(STATE_DIR, n));
  } catch { return []; }
}

/** Most recently active session record (per-session state files, with the
 * legacy single state.json as a fallback for old installs). */
function loadCurrentSession(): State | null {
  const candidates: State[] = [];
  for (const file of listDataFiles(/^state-.+\.json$/)) {
    const s = readJSON<State>(file);
    if (s && typeof s.sessionStart === 'number') candidates.push(s);
  }
  const legacy = readJSON<State>(STATE_FILE);
  if (legacy && typeof legacy.sessionStart === 'number') candidates.push(legacy);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) =>
    (b.lastActive ?? b.sessionStart ?? 0) - (a.lastActive ?? a.sessionStart ?? 0));
  return candidates[0];
}

/** All events across per-session event files (plus the legacy events.json),
 * honoring each file's clearedAt watermark. */
function loadAllEvents(): Event[] {
  const files = listDataFiles(/^events-.+\.json$/);
  files.push(EVENTS_FILE); // legacy single-file location
  const all: Event[] = [];
  for (const file of files) {
    const data = readJSON<EventsFile>(file);
    if (!data || !Array.isArray(data.events)) continue;
    const clearedAt = typeof data.clearedAt === 'number' ? data.clearedAt : 0;
    for (const e of data.events) {
      if (e && typeof e.ts === 'number' && e.ts > clearedAt) all.push(e);
    }
  }
  return all;
}

function formatDuration(mins: number): string {
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d${rh}h` : `${d}d`;
}

function formatDate(ts: number): string {
  // Local calendar date — toISOString would give the UTC date, which is off
  // by one day for morning timestamps in UTC+ timezones.
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function tierFromSessions(n: number): { name: string; next: string | null; toGo: number } {
  if (n >= 50) return { name: 'bestie', next: null, toGo: 0 };
  if (n >= 15) return { name: 'friend', next: 'bestie', toGo: 50 - n };
  if (n >= 3) return { name: 'acquaintance', next: 'friend', toGo: 15 - n };
  return { name: 'stranger', next: 'acquaintance', toGo: 3 - n };
}

function bar(pct: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  const empty = width - filled;
  if (COLOR_LEVEL === 'none') {
    return `[${'#'.repeat(filled)}${'-'.repeat(empty)}]`;
  }
  return `${rgb(100, 200, 255)}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`;
}

function heading(text: string): string {
  if (COLOR_LEVEL === 'none') return text;
  return `${rgb(255, 200, 80)}${text}${RESET}`;
}

function label(text: string): string {
  if (COLOR_LEVEL === 'none') return text;
  return `${DIM}${text}${RESET}`;
}

const ANIMALS: AnimalType[] = ['cat', 'penguin', 'owl', 'octopus', 'bunny'];

function summarizeEvents(events: Event[]): { tests: { pass: number; fail: number }; commits: number; edits: number; recent: number } {
  let testPass = 0, testFail = 0, commits = 0, edits = 0;
  const cutoff = Date.now() - 24 * 3600_000;
  let recent = 0;
  for (const e of events) {
    if (e.ts > cutoff) recent++;
    if (e.type === 'bash') {
      const cmd = e.detail.toLowerCase();
      if (/\b(test|vitest|jest|pytest|cargo\s+test)\b/.test(cmd)) {
        if (e.ok) testPass++; else testFail++;
      }
      if (/\bgit\s+commit\b/.test(cmd)) commits++;
    }
    if (e.type === 'edit' || e.type === 'write') edits++;
  }
  return { tests: { pass: testPass, fail: testFail }, commits, edits, recent };
}

export function runStats(): void {
  loadConfig();
  const cfg = getConfig();
  const mem = readJSON<Memory>(MEMORY_FILE);
  const state = loadCurrentSession();
  const events = loadAllEvents();

  if (!mem || !mem.totalSessions) {
    console.log('No codachi memory yet — run Claude Code once to hatch your pet.');
    return;
  }

  const animalIdx = state?.animalIndex ?? 0;
  const animal = ANIMALS[animalIdx] ?? 'cat';
  const petName = cfg.name || getAnimalName(animal);

  const sessions = mem.totalSessions ?? 0;
  const uptimeMin = mem.totalUptimeMin ?? 0;
  const firstMet = mem.firstMet ?? Date.now();
  const lastSeen = mem.lastSeen ?? Date.now();
  const daysKnown = Math.max(1, Math.floor((Date.now() - firstMet) / 86400_000));
  const avgSessionMin = sessions ? Math.round(uptimeMin / sessions) : 0;

  const tier = tierFromSessions(sessions);
  const tierPct = tier.next
    ? Math.min(100, Math.round((sessions / (sessions + tier.toGo)) * 100))
    : 100;

  const e = summarizeEvents(events);

  const lines: string[] = [];
  lines.push('');
  lines.push(heading(`codachi stats — ${petName} the ${animal}`));
  lines.push('');
  lines.push(`  ${label('first met    ')} ${formatDate(firstMet)}  (${daysKnown}d ago)`);
  lines.push(`  ${label('last seen    ')} ${formatDate(lastSeen)}`);
  lines.push(`  ${label('sessions     ')} ${sessions}`);
  lines.push(`  ${label('total uptime ')} ${formatDuration(uptimeMin)}`);
  lines.push(`  ${label('avg session  ')} ${formatDuration(avgSessionMin)}`);
  lines.push('');
  lines.push(heading('  relationship'));
  if (tier.next) {
    lines.push(`  ${label('current      ')} ${tier.name}`);
    lines.push(`  ${label('progress     ')} ${bar(tierPct, 20)} ${tierPct}%`);
    lines.push(`  ${label('next tier    ')} ${tier.next} (${tier.toGo} more session${tier.toGo === 1 ? '' : 's'})`);
  } else {
    lines.push(`  ${label('current      ')} ${tier.name}  (max tier ✓)`);
  }
  lines.push('');
  lines.push(heading('  recent activity (last 24h from local events)'));
  lines.push(`  ${label('events       ')} ${e.recent}`);
  lines.push(`  ${label('tests        ')} ${e.tests.pass} pass · ${e.tests.fail} fail`);
  lines.push(`  ${label('commits      ')} ${e.commits}`);
  lines.push(`  ${label('edits        ')} ${e.edits}`);
  lines.push('');
  if (state?.sessionStart) {
    // Rendered time (sessionStart → lastActive), not wall-clock since start —
    // a session last seen yesterday shouldn't read as a day long.
    const end = Math.max(state.sessionStart, state.lastActive ?? state.sessionStart);
    const curMin = Math.floor((end - state.sessionStart) / 60000);
    lines.push(`  ${label('this session ')} ${formatDuration(curMin)}`);
    lines.push('');
  }

  console.log(lines.join('\n'));
}
