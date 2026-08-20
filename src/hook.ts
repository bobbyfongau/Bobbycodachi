#!/usr/bin/env node
/**
 * Claude Code PostToolExecution hook — logs tool events for codachi.
 * Receives JSON on stdin from Claude Code, appends to the per-session
 * events file (keyed by transcript path / session id, matching the
 * statusline's keying so both sides agree on which session an event
 * belongs to).
 * Must exit quickly to never block Claude Code.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite } from './fs-utils.js';
import { logError } from './log.js';
import { deriveSessionKey, eventsFileFor, readEventsFile } from './events.js';

const EVENTS_DIR = path.join(os.homedir(), '.claude', 'plugins', 'codachi');
const MAX_EVENTS = 50;

interface CodachiEvent {
  type: string;
  detail: string;
  ok: boolean;
  ts: number;
}

function extractFilePath(input: Record<string, unknown>): string {
  return String(input.file_path ?? input.filePath ?? '');
}

function detectExitCode(data: Record<string, unknown>): boolean {
  // Check top-level exit_code (some Claude Code versions)
  const topCode = data.exit_code ?? data.exitCode;
  if (topCode !== undefined) return Number(topCode) === 0;

  // tool_response is what current Claude Code actually sends; the rest
  // are legacy/alternate spellings kept as fallbacks.
  const output = data.tool_response ?? data.tool_output ?? data.tool_result ?? data.toolResult ?? data.output ?? '';

  // Structured result object
  if (typeof output === 'object' && output !== null) {
    const out = output as Record<string, unknown>;
    const code = out.exit_code ?? out.exitCode ?? out.code;
    if (code !== undefined) return Number(code) === 0;

    // Bash tool_response shape: { stdout, stderr, interrupted } — no exit
    // code field, so scan the text for an "exit code: N" trace.
    const text = [out.stdout, out.stderr]
      .filter((v): v is string => typeof v === 'string')
      .join('\n');
    const m = text.match(/exit code[:\s]+(\d+)/i);
    if (m) return m[1] === '0';
    if (out.interrupted === true) return false;
    return true;
  }

  // String result — look for "Exit code: N" pattern
  if (typeof output === 'string') {
    const m = output.match(/exit code[:\s]+(\d+)/i);
    if (m) return m[1] === '0';
  }

  // Unknown — assume success (optimistic default)
  return true;
}

function parseEvent(data: Record<string, unknown>): CodachiEvent | null {
  const toolName = String(data.tool_name ?? data.toolName ?? '').toLowerCase();
  const toolInput = (data.tool_input ?? data.toolInput ?? {}) as Record<string, unknown>;

  if (!toolName) return null;

  switch (toolName) {
    case 'bash': {
      const cmd = String(toolInput.command ?? '').slice(0, 300);
      if (!cmd) return null;
      return { type: 'bash', detail: cmd, ok: detectExitCode(data), ts: Date.now() };
    }
    case 'edit':
    case 'write': {
      const file = extractFilePath(toolInput);
      if (!file) return null;
      return { type: toolName, detail: path.basename(file), ok: true, ts: Date.now() };
    }
    case 'read': {
      const file = extractFilePath(toolInput);
      if (!file) return null;
      return { type: 'read', detail: path.basename(file), ok: true, ts: Date.now() };
    }
    case 'glob': {
      const pattern = String(toolInput.pattern ?? '').slice(0, 100);
      return { type: 'search', detail: pattern || 'glob', ok: true, ts: Date.now() };
    }
    case 'grep': {
      const pattern = String(toolInput.pattern ?? '').slice(0, 100);
      return { type: 'search', detail: pattern || 'grep', ok: true, ts: Date.now() };
    }
    case 'agent': {
      const desc = String(toolInput.description ?? toolInput.prompt ?? '').slice(0, 80);
      return { type: 'agent', detail: desc || 'subagent', ok: true, ts: Date.now() };
    }
    case 'websearch':
    case 'webfetch': {
      const query = String(toolInput.query ?? toolInput.url ?? '').slice(0, 100);
      return { type: 'web', detail: query || toolName, ok: true, ts: Date.now() };
    }
    case 'lsp': {
      return { type: 'lsp', detail: String(toolInput.action ?? 'lsp').slice(0, 50), ok: true, ts: Date.now() };
    }
    default:
      return { type: 'other', detail: toolName.slice(0, 50), ok: true, ts: Date.now() };
  }
}

/**
 * Append an event with retry-on-conflict.
 *
 * Problem: two hook invocations can overlap (read → modify → write),
 * causing the slower one to overwrite the faster one's append.
 *
 * Solution: read the current file, append our event, write it back.
 * After writing, re-read and verify our specific event is present
 * (matched by timestamp). If a concurrent hook overwrote us, we retry
 * once with the fresh state (which already contains the other hook's
 * event, so both survive).
 *
 * readEventsFile drops any events at or before the file's clearedAt
 * watermark, and we carry that watermark forward on every write, so a
 * cleared session's events can never be resurrected through this path.
 * The monotonic totalCount/totalEditCount counters survive the 50-event
 * trim so milestones don't saturate at the cap.
 */
const MAX_RETRIES = 1;

function appendEvent(event: CodachiEvent, key: string = 'default'): void {
  try {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
  } catch (err) {
    logError('hook.appendEvent.mkdir', err);
  }

  const file = eventsFileFor(key);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const { events, totalCount, totalEditCount, clearedAt } = readEventsFile(file);
    events.push(event);
    const trimmed = events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
    const isEdit = event.type === 'edit' || event.type === 'write';
    const payload = JSON.stringify({
      events: trimmed,
      totalCount: totalCount + 1,
      totalEditCount: totalEditCount + (isEdit ? 1 : 0),
      ...(clearedAt > 0 ? { clearedAt } : {}),
    });

    if (!atomicWrite(file, payload)) {
      continue; // write failed — retry
    }

    // Verify our event landed by checking the last event's timestamp.
    // If another hook overwrote us, our event won't be there — retry
    // with fresh state (which includes the other hook's event too).
    if (attempt < MAX_RETRIES) {
      const check = readEventsFile(file).events;
      const found = check.some(e => e.ts === event.ts && e.type === event.type && e.detail === event.detail);
      if (found) return;
      continue;
    }
    return;
  }
}

// Export for testing
export { parseEvent, detectExitCode, extractFilePath, appendEvent };
export type { CodachiEvent };

// ── Main — only runs when executed directly ─────────
const isDirectExecution = process.argv[1]?.endsWith('hook.js') ?? false;
if (isDirectExecution) {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d: string) => chunks.push(d));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(chunks.join('')) as Record<string, unknown>;
      const event = parseEvent(data);
      if (event) {
        const key = deriveSessionKey(
          typeof data.transcript_path === 'string' ? data.transcript_path : undefined,
          typeof data.session_id === 'string' ? data.session_id : undefined,
        );
        appendEvent(event, key);
      }
    } catch (err) {
      logError('hook.main', err);
    }
    process.exit(0);
  });
  // Safety timeout: 5s is generous for file I/O even on slow disks / NFS.
  // The old 2s limit could race with the optimistic-retry appendEvent on
  // slow storage. Claude Code won't block on this — hooks are fire-and-forget.
  setTimeout(() => process.exit(0), 5000);
}
