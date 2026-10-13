/**
 * scripts/memory-vacuum.ts — compact the per-group memory indexes.
 *
 * Usage:
 *   pnpm exec tsx scripts/memory-vacuum.ts [--dry-run] [<index.db> ...]
 *
 * With no paths, every data/v2-memory/<group>/index.db. An operator step, not
 * automatic: VACUUM rewrites the whole file (one large borg delta) and needs
 * the database to itself, so it refuses while the host is running — stop the
 * service first (launchctl unload ~/Library/LaunchAgents/com.nanoclaw.v2.plist)
 * and load it again after. A container still running from before the stop only
 * reads the index; its reads wait out the VACUUM (busy timeout).
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';

export type VacuumResult = { path: string; bytesBefore: number; bytesAfter: number; freeBefore: number };

function hostIsRunning(socketPath: string): Promise<boolean> {
  if (!fs.existsSync(socketPath)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const probe = net.createConnection(socketPath);
    const done = (live: boolean): void => {
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(1000, () => done(true)); // no verdict counts as running
  });
}

function defaultIndexPaths(): string[] {
  const root = path.join(DATA_DIR, 'v2-memory');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((group) => path.join(root, group, 'index.db'))
    .filter((p) => fs.existsSync(p));
}

export async function vacuumIndexes(opts: {
  paths?: string[];
  socketPath?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}): Promise<VacuumResult[]> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const socketPath = opts.socketPath ?? path.join(DATA_DIR, 'ncl.sock');
  if (!opts.dryRun && (await hostIsRunning(socketPath))) {
    throw new Error(`the host is running (${socketPath} answers): stop the service, then run this again`);
  }

  const results: VacuumResult[] = [];
  for (const dbPath of opts.paths ?? defaultIndexPaths()) {
    const db = new Database(dbPath);
    try {
      db.pragma('busy_timeout = 60000');
      const pageSize = db.pragma('page_size', { simple: true }) as number;
      const freeBefore = (db.pragma('freelist_count', { simple: true }) as number) * pageSize;
      const bytesBefore = fs.statSync(dbPath).size;
      log(`${dbPath}: ${mb(bytesBefore)}, ${mb(freeBefore)} free`);
      if (opts.dryRun) {
        results.push({ path: dbPath, bytesBefore, bytesAfter: bytesBefore, freeBefore });
        continue;
      }
      const check = db.pragma('quick_check', { simple: true });
      if (check !== 'ok') throw new Error(`${dbPath}: quick_check failed (${String(check)}) — not vacuuming`);
      db.exec('VACUUM');
      const bytesAfter = fs.statSync(dbPath).size;
      log(`${dbPath}: vacuumed, ${mb(bytesBefore)} → ${mb(bytesAfter)}`);
      results.push({ path: dbPath, bytesBefore, bytesAfter, freeBefore });
    } finally {
      db.close();
    }
  }
  return results;
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(0)} MB`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const paths = args.filter((a) => a !== '--dry-run');
  vacuumIndexes({ paths: paths.length > 0 ? paths : undefined, dryRun }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
