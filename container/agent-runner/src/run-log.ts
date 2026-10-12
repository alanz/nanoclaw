/**
 * One log file per container run, in the session folder.
 *
 * Containers run detached and are removed on exit (`--rm`), so whatever the
 * agent-runner printed went with them, and a silent failure could not be
 * diagnosed afterwards. v1 kept a file per run on the host; here the runner
 * keeps its own, under /workspace/logs/ — the session directory, which the
 * host sees at data/v2-sessions/<group>/<session>/logs/.
 *
 * The console methods are wrapped rather than the streams: Bun's console
 * writes to the file descriptors natively, not through process.stderr.write.
 * Each process (the runner, the MCP server) keeps its own file. Older files
 * are pruned at start; a file stops growing at MAX_FILE_BYTES.
 */
import fs from 'fs';
import path from 'path';
import { format } from 'util';

export const RUN_LOG_DIR = '/workspace/logs';
/** Files kept per session, across all processes. */
const KEEP_FILES = 40;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
/**
 * Lines are labelled by stream, not severity: the runner's ordinary logging
 * goes through console.error, so a severity label would mark every line an
 * error.
 */
const STREAM: Record<(typeof METHODS)[number], string> = {
  log: 'stdout',
  info: 'stdout',
  debug: 'stdout',
  warn: 'stderr',
  error: 'stderr',
};

export interface RunLog {
  file: string;
  /** Restore the console and close the file (tests; a run just exits). */
  stop(): void;
}

export function startRunLog(processName: string, dir: string = RUN_LOG_DIR): RunLog | null {
  let fd: number;
  let file: string;
  try {
    fs.mkdirSync(dir, { recursive: true });
    prune(dir, KEEP_FILES - 1);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    file = path.join(dir, `${stamp}-${processName}-${process.pid}.log`);
    fd = fs.openSync(file, 'a');
  } catch {
    return null; // a run without a log file is still a run
  }

  let written = 0;
  const append = (level: string, args: unknown[]): void => {
    if (written >= MAX_FILE_BYTES) return;
    try {
      let line = `${new Date().toISOString()} ${level} ${format(...args)}\n`;
      written += Buffer.byteLength(line);
      if (written >= MAX_FILE_BYTES) line += `${new Date().toISOString()} log capped at ${MAX_FILE_BYTES} bytes\n`;
      fs.writeSync(fd, line);
    } catch {
      // never let logging break the run
    }
  };

  const originals = METHODS.map((method) => [method, console[method]] as const);
  for (const [method, original] of originals) {
    console[method] = (...args: unknown[]) => {
      append(STREAM[method], args);
      original.apply(console, args);
    };
  }
  const monitor = (err: Error): void => append('uncaught', [err]);
  // Observe-only: an 'uncaughtException' / 'unhandledRejection' listener
  // would stop the process from crashing, which is not ours to change.
  process.on('uncaughtExceptionMonitor', monitor);
  append('info', [`run log started: ${processName} pid ${process.pid}`]);
  return {
    file,
    stop() {
      for (const [method, original] of originals) console[method] = original;
      process.off('uncaughtExceptionMonitor', monitor);
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    },
  };
}

/** Keep the newest `keep` files. */
function prune(dir: string, keep: number): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .sort(); // ISO-stamped names sort by time
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    try {
      fs.unlinkSync(path.join(dir, f));
    } catch {
      // already gone
    }
  }
}
