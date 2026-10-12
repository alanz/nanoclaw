import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'bun:test';

import { startRunLog, type RunLog } from './run-log.js';

let dir: string;
let run: RunLog | null = null;

afterEach(() => {
  run?.stop();
  run = null;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('run log', () => {
  it('copies console output into a per-run file and still prints it', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-log-'));
    const printed: unknown[][] = [];
    const before = console.error;
    console.error = (...args: unknown[]) => printed.push(args);
    try {
      run = startRunLog('runner', dir);
      console.error('[poll-loop] claimed', 2, 'messages');
    } finally {
      run?.stop();
      console.error = before;
    }
    expect(printed).toEqual([['[poll-loop] claimed', 2, 'messages']]);
    const text = fs.readFileSync(run!.file, 'utf8');
    expect(path.basename(run!.file)).toMatch(/-runner-\d+\.log$/);
    expect(text).toContain('run log started: runner');
    expect(text).toMatch(/ stderr \[poll-loop\] claimed 2 messages\n/);
  });

  it('keeps only the newest files', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-log-'));
    for (let i = 0; i < 45; i++)
      fs.writeFileSync(path.join(dir, `2026-01-01T00-00-${String(i).padStart(2, '0')}-runner-1.log`), '');
    run = startRunLog('runner', dir);
    const files = fs.readdirSync(dir).sort();
    expect(files).toHaveLength(40);
    expect(files[0]).toBe('2026-01-01T00-00-06-runner-1.log');
    expect(files).toContain(path.basename(run!.file));
  });

  it('restores the console on stop', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-log-'));
    const before = console.warn;
    run = startRunLog('mcp', dir);
    expect(console.warn).not.toBe(before);
    run!.stop();
    run = null;
    expect(console.warn).toBe(before);
  });
});
