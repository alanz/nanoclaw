/**
 * v1 told the requester what a failed specialist was doing; v2 said only
 * "Specialist task failed: timeout" (2026-10-12 audit).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dirs = vi.hoisted(() => ({ data: '' }));
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    get DATA_DIR() {
      return dirs.data;
    },
  };
});

import { OUTBOUND_SCHEMA } from '../../mailbox/sqlite/schema.js';
import { buildPostMortem, summariseTranscript } from './postmortem.js';

const AG = 'ag-rsrch';
const SESS = 'sess-spec-1';
const CONV = '4a529c99-0000-0000-0000-000000000001';

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content }, ...extra });
const toolResult = (text: string, isError = false) =>
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text }], is_error: isError }],
    },
  });

beforeEach(() => {
  dirs.data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'postmortem-')));
});
afterEach(() => {
  fs.rmSync(dirs.data, { recursive: true, force: true });
});

describe('summariseTranscript', () => {
  it('reports the last tool call and its result, the last text, and an API error', () => {
    const jsonl = [
      '{"cut off by the tail',
      assistant([{ type: 'text', text: 'Fetching the roadmap first.' }]),
      assistant([{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://ghc.serokell.io/dh' } }]),
      toolResult('Request failed with status 503', true),
      assistant([{ type: 'text', text: 'API Error: overloaded' }], { isApiErrorMessage: true }),
    ].join('\n');

    expect(summariseTranscript(jsonl)).toEqual([
      '• Last tool: WebFetch({"url":"https://ghc.serokell.io/dh"})',
      '  → error: Request failed with status 503',
      '• API error: API Error: overloaded',
      '• Last said: Fetching the roadmap first.',
    ]);
  });

  it('says when the last tool never returned', () => {
    const jsonl = assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 9999' } }]);
    expect(summariseTranscript(jsonl)).toEqual([
      '• Last tool: Bash({"command":"sleep 9999"})',
      '  → no result (still running)',
    ]);
  });
});

describe('buildPostMortem', () => {
  it('reads the session conversation transcript and the newest run log', () => {
    const sessDir = path.join(dirs.data, 'v2-sessions', AG, SESS);
    fs.mkdirSync(path.join(sessDir, 'logs'), { recursive: true });
    const db = new Database(path.join(sessDir, 'outbound.db'));
    db.exec(OUTBOUND_SCHEMA);
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'continuation:claude',
      CONV,
      new Date().toISOString(),
    );
    db.close();
    const projects = path.join(dirs.data, 'v2-sessions', AG, '.claude-shared', 'projects', '-workspace-agent');
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(
      path.join(projects, `${CONV}.jsonl`),
      assistant([{ type: 'tool_use', name: 'WebSearch', input: { query: 'dependent haskell' } }]) + '\n',
    );
    fs.writeFileSync(path.join(sessDir, 'logs', '2026-10-12T20-00-00-000Z-runner-2.log'), 'old\n');
    fs.writeFileSync(
      path.join(sessDir, 'logs', '2026-10-12T21-00-00-000Z-runner-2.log'),
      'a\nstderr [poll-loop] last words\n',
    );

    expect(buildPostMortem(AG, SESS)).toBe(
      [
        'What the specialist was doing:',
        '• Last tool: WebSearch({"query":"dependent haskell"})',
        '  → no result (still running)',
        '• Last log line: stderr [poll-loop] last words',
      ].join('\n'),
    );
  });

  it("reads the task's own transcript, in its session folder, before the group's", () => {
    const sessDir = path.join(dirs.data, 'v2-sessions', AG, SESS);
    fs.mkdirSync(sessDir, { recursive: true });
    const db = new Database(path.join(sessDir, 'outbound.db'));
    db.exec(OUTBOUND_SCHEMA);
    db.prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)').run(
      'continuation:claude',
      CONV,
      new Date().toISOString(),
    );
    db.close();
    const write = (root: string, query: string) => {
      const projects = path.join(root, '.claude-shared', 'projects', '-workspace-agent');
      fs.mkdirSync(projects, { recursive: true });
      fs.writeFileSync(
        path.join(projects, `${CONV}.jsonl`),
        assistant([{ type: 'tool_use', name: 'WebSearch', input: { query } }]) + '\n',
      );
    };
    write(path.join(dirs.data, 'v2-sessions', AG), 'from the group');
    write(sessDir, 'from the task');

    expect(buildPostMortem(AG, SESS)).toContain('"query":"from the task"');
  });

  it('is null for a session that never ran', () => {
    expect(buildPostMortem(AG, 'sess-never')).toBeNull();
  });
});
