/**
 * Event reader + classifier for codachi hooks system.
 * Reads events logged by the hook script and provides
 * classified context for the mood system.
 *
 * Events are stored PER SESSION: each Claude Code session gets its own
 * events-<key>.json, where <key> is a short hash of the transcript path
 * (falling back to the session id, then 'default'). This lets two
 * concurrent Claude Code windows coexist without wiping each other's
 * events. The file also carries monotonic totalCount / totalEditCount
 * counters (unaffected by the 50-event trim) and a clearedAt watermark
 * so a cleared file's contents can never be resurrected by a racing
 * hook write.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { atomicWrite } from './fs-utils.js';
import { logError } from './log.js';

const EVENTS_DIR = path.join(os.homedir(), '.claude', 'plugins', 'codachi');

interface RawEvent {
  type: string;
  detail: string;
  ok: boolean;
  ts: number;
}

interface EventsFileData {
  events?: RawEvent[];
  totalCount?: number;
  totalEditCount?: number;
  clearedAt?: number;
}

export interface EventsFileState {
  events: RawEvent[];
  totalCount: number;
  totalEditCount: number;
  clearedAt: number;
}

// ── Session keying ──────────────────────────────────

/**
 * Stable per-session key: short hash of the transcript path (unique per
 * Claude Code session), falling back to the session id, then 'default'.
 * A missing transcript path must always map to the SAME key so a caller
 * that omits it doesn't trigger a new-session reset on every render.
 */
export function deriveSessionKey(transcriptPath?: string, sessionId?: string): string {
  const src = (transcriptPath && transcriptPath.trim()) || (sessionId && sessionId.trim()) || '';
  if (!src) return 'default';
  return crypto.createHash('sha256').update(src).digest('hex').slice(0, 12);
}

export function eventsFileFor(key: string): string {
  return path.join(EVENTS_DIR, `events-${key}.json`);
}

// The statusline sets this once per invocation (from initSession) so
// getEventContext() reads the current session's events without a
// signature change for callers.
let activeSessionKey = 'default';

export function setActiveSessionKey(key: string): void {
  activeSessionKey = key;
}

export function getActiveSessionKey(): string {
  return activeSessionKey;
}

// ── Load events from disk ───────────────────────────

function isValidEvent(e: unknown): e is RawEvent {
  const ev = e as RawEvent | null;
  return !!ev && typeof ev === 'object'
    && typeof ev.type === 'string'
    && typeof ev.ts === 'number' && Number.isFinite(ev.ts);
}

function countEdits(events: RawEvent[]): number {
  return events.filter(e => e.type === 'edit' || e.type === 'write').length;
}

/**
 * Read an events file, dropping any events at or before the clearedAt
 * watermark (so pre-clear events are never resurrected) and floor-ing
 * the monotonic counters at what the visible events imply (legacy files
 * without counters still work).
 */
export function readEventsFile(file: string): EventsFileState {
  const empty: EventsFileState = { events: [], totalCount: 0, totalEditCount: 0, clearedAt: 0 };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as EventsFileData;
    const clearedAt = typeof data.clearedAt === 'number' && Number.isFinite(data.clearedAt) ? data.clearedAt : 0;
    const all = Array.isArray(data.events) ? data.events.filter(isValidEvent) : [];
    const events = clearedAt > 0 ? all.filter(e => e.ts > clearedAt) : all;
    const rawTotal = Number(data.totalCount);
    const rawEditTotal = Number(data.totalEditCount);
    return {
      events,
      totalCount: Math.max(Number.isFinite(rawTotal) ? rawTotal : 0, events.length),
      totalEditCount: Math.max(Number.isFinite(rawEditTotal) ? rawEditTotal : 0, countEdits(events)),
      clearedAt,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logError('events.loadEvents', err);
    }
    return empty;
  }
}

/** Clear the session's events file — used when a session key is reused
 * (e.g. the fallback key) to prevent cross-session bleed. The clearedAt
 * watermark guarantees pre-clear events stay dead even if a racing hook
 * write briefly resurrects them on disk. */
export function clearEvents(key: string = activeSessionKey): void {
  atomicWrite(eventsFileFor(key), JSON.stringify({
    events: [],
    totalCount: 0,
    totalEditCount: 0,
    clearedAt: Date.now(),
  }));
}

export type EventCategory =
  | 'test_passed' | 'test_failed'
  | 'build_passed' | 'build_failed'
  | 'install'
  | 'git_commit' | 'git_push' | 'git_pull' | 'git_merge' | 'git_rebase' | 'git_stash' | 'git_checkout'
  | 'lint_format'
  | 'server_start'
  | 'docker'
  | 'network'
  | 'dangerous'
  | 'search'
  | 'edit_test' | 'edit_docs' | 'edit_style' | 'edit_config' | 'edit_code'
  | 'creating_file'
  | 'exploring'
  | 'rapid_editing'
  | 'bash_failed'
  | 'recovered'
  | 'struggling'
  | 'first_action'
  | 'many_edits'
  | 'many_actions'
  | 'web_research'
  | 'agent_spawned'
  | 'code_analysis';

export interface EventContext {
  category: EventCategory | null;
  freshness: 'hot' | 'warm' | 'cold' | 'none';
  detail: string;
  consecutiveFailures: number;
  sessionEditCount: number;
  sessionActionCount: number;
}

// ── Classify a bash command ─────────────────────────

function classifyBash(cmd: string, ok: boolean): EventCategory | null {
  const c = cmd.toLowerCase();

  // Testing
  if (/\b(jest|vitest|mocha|pytest|cargo\s+test|go\s+test|rspec|npm\s+test|npx\s+test|yarn\s+test|pnpm\s+test|bun\s+test|playwright|cypress)\b/.test(c)) {
    return ok ? 'test_passed' : 'test_failed';
  }

  // Building
  if (/\b(npm\s+run\s+build|cargo\s+build|make\b|go\s+build|tsc\b|webpack|vite\s+build|next\s+build|turbo\s+build|gradle\s+build|mvn\s+(compile|package))\b/.test(c)) {
    return ok ? 'build_passed' : 'build_failed';
  }

  // Installing
  if (/\b(npm\s+(install|i|ci)\b|yarn\s+(add|install)|pnpm\s+(add|install)|pip\s+install|cargo\s+add|go\s+(get|mod\s+tidy)|brew\s+install|apt\s+install)\b/.test(c)) {
    return 'install';
  }

  // Git operations (order matters — commit before generic git)
  if (/\bgit\s+commit\b/.test(c)) return 'git_commit';
  if (/\bgit\s+push\b/.test(c)) return 'git_push';
  if (/\bgit\s+(pull|fetch)\b/.test(c)) return 'git_pull';
  if (/\bgit\s+merge\b/.test(c)) return 'git_merge';
  if (/\bgit\s+rebase\b/.test(c)) return 'git_rebase';
  if (/\bgit\s+stash\b/.test(c)) return 'git_stash';
  if (/\bgit\s+(checkout|switch)\b/.test(c)) return 'git_checkout';

  // Linting/formatting
  if (/\b(eslint|prettier|cargo\s+(fmt|clippy)|black|ruff|gofmt|rustfmt|biome|stylelint)\b/.test(c)) {
    return 'lint_format';
  }

  // Server/running — only specific server commands, not generic node/python
  if (/\b(npm\s+(start|run\s+dev)|yarn\s+(start|dev)|pnpm\s+dev|cargo\s+run|go\s+run|flask\s+run|uvicorn|gunicorn|next\s+dev)\b/.test(c)) {
    return 'server_start';
  }

  // Docker/K8s
  if (/\b(docker|docker-compose|podman|kubectl)\b/.test(c)) return 'docker';

  // Network — only explicit HTTP tools, not generic words
  if (/\b(curl|wget|ssh\s|scp\s|rsync)\b/.test(c)) return 'network';

  // Dangerous
  if (/\brm\s+(-rf|--force)|\bdrop\s+(table|database)|\bgit\s+(reset\s+--hard|push\s+--force|push\s+-f|clean\s+-f)\b/.test(c)) {
    return 'dangerous';
  }

  // Search
  if (/\b(grep|rg\s|find\s|fd\s|ag\s|ack\s|fzf)\b/.test(c)) return 'search';

  // Generic failure
  if (!ok) return 'bash_failed';

  return null;
}

// ── Classify a file by name ─────────────────────────

function classifyFile(filename: string): EventCategory {
  const f = filename.toLowerCase();
  if (/\.(test|spec)\.[jt]sx?$|_test\.(go|py|rs|rb)$|test_.*\.py$/.test(f)) return 'edit_test';
  if (/\.(md|rst|txt|adoc)$|^readme|^changelog|^contributing|^license/i.test(f)) return 'edit_docs';
  if (/\.(css|scss|sass|less|styl)$/.test(f)) return 'edit_style';
  if (/\.(json|ya?ml|toml|ini|env|conf|cfg)$|^\..*rc$|dockerfile|makefile|\.lock$/i.test(f)) return 'edit_config';
  return 'edit_code';
}

// ── Main classification ─────────────────────────────

export function getEventContext(): EventContext {
  const { events, totalCount, totalEditCount } = readEventsFile(eventsFileFor(activeSessionKey));
  const now = Date.now();

  const noEvents: EventContext = {
    category: null,
    freshness: 'none',
    detail: '',
    consecutiveFailures: 0,
    sessionEditCount: 0,
    sessionActionCount: 0,
  };

  if (events.length === 0) return noEvents;

  // Count consecutive bash failures from the end
  let consecutiveFailures = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'bash' && !events[i].ok) consecutiveFailures++;
    else break;
  }

  const latest = events[events.length - 1];
  const age = now - latest.ts;

  // Determine freshness
  let freshness: EventContext['freshness'];
  if (age < 15000) freshness = 'hot';
  else if (age < 60000) freshness = 'warm';
  else if (age < 300000) freshness = 'cold';
  else return noEvents; // stale — no event context

  const ctx: EventContext = {
    category: null,
    freshness,
    detail: latest.detail,
    consecutiveFailures,
    sessionEditCount: totalEditCount,
    sessionActionCount: totalCount,
  };

  // ── Pattern detection (highest priority) ──

  // Struggling: 3+ consecutive bash failures
  if (consecutiveFailures >= 3) {
    ctx.category = 'struggling';
    return ctx;
  }

  // Recovery: bash fail → bash success (same-type recovery only)
  if (latest.type === 'bash' && latest.ok && events.length >= 2) {
    const prev = events[events.length - 2];
    if (prev.type === 'bash' && !prev.ok) {
      ctx.category = 'recovered';
      return ctx;
    }
  }

  // Rapid editing: 5+ edits in 60s
  const recentEdits = events.filter(e =>
    (e.type === 'edit' || e.type === 'write') && now - e.ts < 60000
  ).length;
  if (recentEdits >= 5) {
    ctx.category = 'rapid_editing';
    return ctx;
  }

  // Deep exploring: 6+ reads/searches in 60s
  const recentExploring = events.filter(e =>
    (e.type === 'read' || e.type === 'search' || e.type === 'lsp') && now - e.ts < 60000
  ).length;
  if (recentExploring >= 6) {
    ctx.category = 'exploring';
    return ctx;
  }

  // Milestones — based on MONOTONIC counters (unaffected by the 50-event
  // file trim), so 'many_actions' fires only when the latest event crossed
  // a multiple, never permanently once the file saturates at the cap.
  if (totalCount === 1) {
    ctx.category = 'first_action';
    return ctx;
  }
  if (totalEditCount > 0 && totalEditCount % 25 === 0
    && (latest.type === 'edit' || latest.type === 'write')) {
    ctx.category = 'many_edits';
    return ctx;
  }
  if (totalCount >= 50 && totalCount % 50 === 0) {
    ctx.category = 'many_actions';
    return ctx;
  }

  // ── Single-event classification ──

  if (latest.type === 'bash') {
    ctx.category = classifyBash(latest.detail, latest.ok);
  } else if (latest.type === 'write') {
    ctx.category = 'creating_file';
  } else if (latest.type === 'edit') {
    ctx.category = classifyFile(latest.detail);
  } else if (latest.type === 'search') {
    ctx.category = 'search';
  } else if (latest.type === 'agent') {
    ctx.category = 'agent_spawned';
  } else if (latest.type === 'web') {
    ctx.category = 'web_research';
  } else if (latest.type === 'lsp') {
    ctx.category = 'code_analysis';
  }
  // plain reads alone are not interesting enough for a mood change

  return ctx;
}
