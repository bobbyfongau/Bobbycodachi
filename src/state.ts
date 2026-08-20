import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { clearEvents, deriveSessionKey, eventsFileFor, setActiveSessionKey } from './events.js';
import { atomicWrite } from './fs-utils.js';
import { logError } from './log.js';

const STATE_DIR = path.join(os.homedir(), '.claude', 'plugins', 'codachi');
const MEMORY_FILE = path.join(STATE_DIR, 'memory.json');

// Schema versions. Bump when shape changes and add a migration below.
// Rule: never break an older codachi trying to read a newer file — be
// additive when possible and carry old fields forward.
const STATE_SCHEMA_VERSION = 1;
const MEMORY_SCHEMA_VERSION = 1;

// Session records older than this are pruned (their uptime is counted first).
const SESSION_MAX_AGE_MS = 7 * 24 * 3600_000;
// A session whose lastActive is at least this stale is considered ended and
// safe to sweep for uptime accounting; fresher ones are likely live in
// another window and get swept later.
const SESSION_SWEEP_IDLE_MS = 2 * 60_000;
// Only rewrite the state file just for lastActive if it moved by more than this.
const LAST_ACTIVE_THROTTLE_MS = 60_000;
// How long the tier-upgrade celebration stays visible.
const TIER_CELEBRATION_MS = 30_000;

// ── Session state (one file per session) ─────────────
//
// Session state is keyed by a stable hash of the transcript path (see
// deriveSessionKey), one state-<key>.json per session, so two concurrent
// Claude Code windows fully coexist: no session-count inflation, no
// species/palette flicker, no event wiping.

interface CtxSample { pct: number; t: number }

interface DiskState {
  version?: number;
  transcriptPath?: string;
  sessionStart?: number;
  lastActive?: number;
  /** Uptime accounted into memory.totalUptimeMin up to this timestamp. */
  uptimeCountedUpTo?: number;
  animalIndex?: number;
  paletteIndex?: number;
  /** Persisted context ring buffer — the statusline is a fresh process per
   * render, so velocity/ETA only work if samples survive process exits. */
  ctxHistory?: CtxSample[];
  // Unknown/future fields are carried forward untouched.
  [key: string]: unknown;
}

function loadJSON<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; }
  catch (err) {
    // ENOENT is normal on first run; only log real parse/IO failures.
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logError('state.loadJSON:' + file, err);
    }
    return null;
  }
}

function saveJSON(file: string, data: unknown): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWrite(file, JSON.stringify(data));
  } catch (err) {
    logError('state.saveJSON:' + file, err);
  }
}

function stateFileFor(key: string): string {
  return path.join(STATE_DIR, `state-${key}.json`);
}

let diskState: DiskState = {};
let sessionKey = 'default';

export function initSession(transcriptPath?: string, sessionId?: string): void {
  sessionKey = deriveSessionKey(transcriptPath, sessionId);
  setActiveSessionKey(sessionKey);
  diskState = migrateState(loadJSON<DiskState>(stateFileFor(sessionKey)));

  // "New session" means "no record exists for this key" — never "the last
  // writer was someone else", so concurrent sessions don't thrash each other
  // and a missing transcript path reuses the stable fallback key.
  if (typeof diskState.sessionStart !== 'number') {
    const now = Date.now();
    // New session: update memory (and sweep ended sessions' uptime),
    // clear any stale events left under a reused key.
    updateMemory();
    clearEvents(sessionKey);
    // One-time upgrade courtesy: adopt the pet identity from a pre-0.4 global
    // state.json so an existing pet doesn't re-randomize species/palette.
    const legacy = migrateState(loadJSON<DiskState>(path.join(STATE_DIR, 'state.json')));
    diskState = {
      version: STATE_SCHEMA_VERSION,
      transcriptPath: transcriptPath ?? '',
      sessionStart: now,
      lastActive: now,
      uptimeCountedUpTo: now,
      animalIndex: isValidIndex(legacy.animalIndex) ? legacy.animalIndex : Math.floor(Math.random() * 5),
      paletteIndex: isValidIndex(legacy.paletteIndex) ? legacy.paletteIndex : Math.floor(Math.random() * 10),
      ctxHistory: [],
    };
    saveJSON(stateFileFor(sessionKey), diskState);
  }
}

// ── State validation / migration ─────────────────────

function isValidIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isValidTimestamp(v: unknown, now: number): boolean {
  // Sane epoch millis: positive, finite, not more than a day in the future.
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= now + 86400_000;
}

function isCtxSample(s: unknown): s is CtxSample {
  const c = s as CtxSample | null;
  return !!c && typeof c === 'object'
    && typeof c.pct === 'number' && Number.isFinite(c.pct)
    && typeof c.t === 'number' && Number.isFinite(c.t);
}

/**
 * Forward-compatible state loader with field validation. A newer-version
 * file keeps its fields AND its version stamp (never silently downgraded);
 * corrupt-but-parseable fields are reset to sane defaults so a bad file can
 * never blank the statusline. Unknown fields ride along untouched.
 */
function migrateState(raw: DiskState | null): DiskState {
  if (!raw || typeof raw !== 'object') return {};
  const now = Date.now();
  const v = typeof raw.version === 'number' && Number.isInteger(raw.version) ? raw.version : 0;
  if (v > STATE_SCHEMA_VERSION) {
    logError('state.migrate', new Error(`state file version ${v} newer than supported ${STATE_SCHEMA_VERSION} — operating read-compatibly on known fields`));
  }
  const state: DiskState = { ...raw };
  // Keep the newer stamp so a newer codachi still recognizes its file.
  state.version = v > STATE_SCHEMA_VERSION ? v : STATE_SCHEMA_VERSION;
  if (!isValidIndex(raw.animalIndex)) delete state.animalIndex;
  if (!isValidIndex(raw.paletteIndex)) delete state.paletteIndex;
  if (!isValidTimestamp(raw.sessionStart, now)) delete state.sessionStart;
  if (!isValidTimestamp(raw.lastActive, now)) delete state.lastActive;
  if (!isValidTimestamp(raw.uptimeCountedUpTo, now)) delete state.uptimeCountedUpTo;
  if (typeof raw.transcriptPath !== 'string') delete state.transcriptPath;
  state.ctxHistory = Array.isArray(raw.ctxHistory) ? raw.ctxHistory.filter(isCtxSample) : [];
  return state;
}

export function getSessionAnimalIndex(): number {
  const i = diskState.animalIndex;
  return isValidIndex(i) ? (i as number) : 0;
}
export function getSessionPaletteIndex(): number {
  const i = diskState.paletteIndex;
  return isValidIndex(i) ? (i as number) : 0;
}

export function animTick(speedSec: number = 1.5): number {
  return Math.floor(Date.now() / (speedSec * 1000));
}
export function moodTick(): number { return Math.floor(Date.now() / 10000); }

/** Ticks (10s units) since the current session actually started.
 * Returns a huge number when no session is initialized, so time-gated
 * "session start" behaviors (like the welcome message) never fire. */
export function sessionAgeTick(): number {
  const start = diskState.sessionStart;
  if (typeof start !== 'number') return Number.MAX_SAFE_INTEGER;
  return Math.floor(Math.max(0, Date.now() - start) / 10000);
}

export function sessionUptime(): string {
  const start = diskState.sessionStart ?? Date.now();
  const ms = Math.max(0, Date.now() - start);
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours}h` : `${hours}h${rem}m`;
}

// ── Context velocity (persisted ring buffer) ─────────
//
// The statusline binary is a one-shot process per render, so the ring
// buffer lives in the per-session state file: load on start (initSession),
// append the current sample, save. Otherwise velocity/ETA can never see
// more than one sample and the feature is dead at runtime.

const CTX_HISTORY_SIZE = 20;

export function recordContextPercent(pct: number): void {
  const now = Date.now();
  let hist = Array.isArray(diskState.ctxHistory) ? diskState.ctxHistory : [];
  const last = hist[hist.length - 1];
  let dirty = false;

  if (last && last.t > now) {
    // Clock went backwards — stale future samples would wedge sampling
    // and corrupt velocity, so start over.
    hist = [];
  }
  // Don't record too frequently (min 1s gap)
  if (hist.length === 0 || now - hist[hist.length - 1].t >= 1000) {
    hist.push({ pct, t: now });
    if (hist.length > CTX_HISTORY_SIZE) hist.splice(0, hist.length - CTX_HISTORY_SIZE);
    diskState.ctxHistory = hist;
    dirty = true;
  }

  // Keep lastActive current. Piggyback on sample writes; force a write only
  // if lastActive would otherwise fall more than the throttle behind.
  const lastActive = typeof diskState.lastActive === 'number' ? diskState.lastActive : 0;
  if (dirty || now - lastActive > LAST_ACTIVE_THROTTLE_MS) {
    if (now > lastActive) diskState.lastActive = now;
    saveJSON(stateFileFor(sessionKey), diskState);
  }
}

/** Returns context velocity in %/min. Positive = growing. */
export function getContextVelocity(): number {
  const hist = Array.isArray(diskState.ctxHistory) ? diskState.ctxHistory : [];
  if (hist.length < 2) return 0;
  const recent = hist[hist.length - 1];
  // Look back ~30s for a stable reading
  let oldest = hist[0];
  for (const entry of hist) {
    if (recent.t - entry.t >= 15000) { oldest = entry; break; }
  }
  const dtMin = (recent.t - oldest.t) / 60000;
  if (dtMin < 0.1) return 0; // too short
  return Math.round(((recent.pct - oldest.pct) / dtMin) * 10) / 10;
}

/** Estimate minutes remaining before context is full. Returns null if velocity <= 0 or unstable. */
export function getContextTimeRemaining(currentPct: number): string | null {
  const vel = getContextVelocity();
  if (vel <= 0.3) return null; // not growing or too slow to predict
  const remaining = 100 - currentPct;
  const mins = Math.round(remaining / vel);
  if (mins <= 0) return null;
  if (mins < 60) return `~${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `~${h}h${m}m` : `~${h}h`;
}

// ── Pet memory (cross-session persistence) ───────────

export interface PetMemory {
  version?: number;
  totalSessions: number;
  totalUptimeMin: number;
  firstMet: number; // timestamp
  lastSeen: number;
  lastShownTier?: string; // for tier upgrade notifications
  tierUpgradedAt?: number; // celebration window anchor
  // Unknown/future fields are carried forward untouched (see loadMemory).
  [key: string]: unknown;
}

let memory: PetMemory | null = null;

function loadMemory(): PetMemory {
  const raw = loadJSON<PetMemory>(MEMORY_FILE);
  if (!raw) {
    return {
      version: MEMORY_SCHEMA_VERSION,
      totalSessions: 0,
      totalUptimeMin: 0,
      firstMet: Date.now(),
      lastSeen: Date.now(),
    };
  }
  const v = typeof raw.version === 'number' ? raw.version : 0;
  if (v > MEMORY_SCHEMA_VERSION) {
    logError('memory.migrate', new Error(`memory file version ${v} newer than supported ${MEMORY_SCHEMA_VERSION}`));
    // Don't wipe or downgrade — spread raw below so unknown future fields
    // and the newer version stamp survive our rewrites.
  }
  // Spread raw first: unknown/future fields are preserved on rewrite.
  // Defensive floors on the known fields in case disk is corrupted.
  const m: PetMemory = {
    ...raw,
    version: v > MEMORY_SCHEMA_VERSION ? v : MEMORY_SCHEMA_VERSION,
    totalSessions: Math.max(0, Number(raw.totalSessions) || 0),
    totalUptimeMin: Math.max(0, Number(raw.totalUptimeMin) || 0),
    firstMet: Number(raw.firstMet) || Date.now(),
    lastSeen: Number(raw.lastSeen) || Date.now(),
    lastShownTier: raw.lastShownTier,
  };
  if (typeof raw.tierUpgradedAt !== 'number' || !Number.isFinite(raw.tierUpgradedAt)) {
    delete m.tierUpgradedAt;
  }
  return m;
}

/**
 * Sweep ended sessions' uptime into minutes and prune old records.
 *
 * Each session file tracks uptimeCountedUpTo; we account the span
 * [countedUpTo → lastActive] once, in whole minutes, so uptime reflects
 * time the statusline actually rendered — never wall-clock gaps between
 * sessions. All deltas are clamped at 0 to survive clock skew. Sessions
 * whose lastActive is fresh are likely live in another window and are
 * skipped; they get swept when they end (or pruned after ~7 days).
 */
function sweepSessionUptime(): number {
  let names: string[];
  try { names = fs.readdirSync(STATE_DIR); }
  catch { return 0; }

  const now = Date.now();
  let minutes = 0;
  for (const name of names) {
    const match = /^state-(.+)\.json$/.exec(name);
    if (!match) continue;
    const key = match[1];
    if (key === sessionKey) continue; // our own record (being created)
    const file = path.join(STATE_DIR, name);
    const s = migrateState(loadJSON<DiskState>(file));
    const start = typeof s.sessionStart === 'number' ? s.sessionStart : 0;
    const lastActive = Math.max(start, typeof s.lastActive === 'number' ? s.lastActive : 0);
    const expired = start === 0 || now - lastActive > SESSION_MAX_AGE_MS;
    const idle = now - lastActive > SESSION_SWEEP_IDLE_MS;

    if (start > 0 && (idle || expired)) {
      const countedUpTo = Math.max(start, typeof s.uptimeCountedUpTo === 'number' ? s.uptimeCountedUpTo : start);
      const deltaMin = Math.floor(Math.max(0, lastActive - countedUpTo) / 60000);
      if (deltaMin > 0) {
        minutes += deltaMin;
        // Advance by whole minutes only, so the remainder is counted later.
        s.uptimeCountedUpTo = countedUpTo + deltaMin * 60000;
        if (!expired) saveJSON(file, s);
      }
    }

    if (expired) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      try { fs.unlinkSync(eventsFileFor(key)); } catch { /* may not exist */ }
    }
  }
  return minutes;
}

function updateMemory(): void {
  // Called when a NEW session starts — account ended sessions' uptime
  // (rendered time only, never Date.now() - sessionStart) and bump counts.
  const m = loadMemory();
  m.totalSessions += 1;
  m.lastSeen = Date.now();
  m.totalUptimeMin += sweepSessionUptime();

  // Check for tier upgrade
  const oldTier = m.lastShownTier ?? 'stranger';
  const newTier = tierFromSessions(m.totalSessions);
  if (newTier !== oldTier && tierRank(newTier) > tierRank(oldTier)) {
    // Persisted timestamp (not a process-local flag): the celebration
    // stays visible for a window instead of exactly one ~300ms frame.
    m.tierUpgradedAt = Date.now();
    m.lastShownTier = newTier;
  }

  saveJSON(MEMORY_FILE, m);
  memory = m;
}

export function getMemory(): PetMemory {
  if (!memory) memory = loadMemory();
  return memory;
}

/** True while a recent tier upgrade's celebration window (~30s) is open. */
export function didTierUpgrade(): boolean {
  const t = getMemory().tierUpgradedAt;
  if (typeof t !== 'number') return false;
  const dt = Date.now() - t;
  return dt >= 0 && dt < TIER_CELEBRATION_MS;
}

export type RelationshipTier = 'stranger' | 'acquaintance' | 'friend' | 'bestie';

function tierFromSessions(n: number): RelationshipTier {
  if (n >= 50) return 'bestie';
  if (n >= 15) return 'friend';
  if (n >= 3) return 'acquaintance';
  return 'stranger';
}

function tierRank(tier: string): number {
  const ranks: Record<string, number> = { stranger: 0, acquaintance: 1, friend: 2, bestie: 3 };
  return ranks[tier] ?? 0;
}

export function getRelationshipTier(): RelationshipTier {
  return tierFromSessions(getMemory().totalSessions);
}
