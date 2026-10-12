import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { vacuumIndexes } from './memory-vacuum.js';

let root: string;
let dbPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-vacuum-'));
  dbPath = path.join(root, 'index.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE t (x TEXT)');
  const insert = db.prepare('INSERT INTO t (x) VALUES (?)');
  for (let i = 0; i < 2000; i++) insert.run('x'.repeat(1000));
  db.exec('DELETE FROM t');
  db.close();
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('memory-vacuum', () => {
  it('compacts an index and reports the sizes', async () => {
    const [r] = await vacuumIndexes({ paths: [dbPath], socketPath: path.join(root, 'none.sock'), log: () => {} });
    expect(r!.freeBefore).toBeGreaterThan(1_000_000);
    expect(r!.bytesAfter).toBeLessThan(r!.bytesBefore);
  });

  it('refuses while the host answers on its socket, and leaves the file alone', async () => {
    const socketPath = path.join(root, 'ncl.sock');
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(socketPath, r));
    try {
      const before = fs.statSync(dbPath).size;
      await expect(vacuumIndexes({ paths: [dbPath], socketPath, log: () => {} })).rejects.toThrow(/host is running/);
      expect(fs.statSync(dbPath).size).toBe(before);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('a dry run reports without changing anything, even with the host up', async () => {
    const before = fs.statSync(dbPath).size;
    const [r] = await vacuumIndexes({ paths: [dbPath], dryRun: true, log: () => {} });
    expect(r!.bytesAfter).toBe(before);
    expect(fs.statSync(dbPath).size).toBe(before);
  });
});
