import { getDb } from '../db/connection.js';

export type MemoryFileStatus = 'pending' | 'indexed' | 'removed';

export type MemoryFile = {
  id: string;
  group_id: string;
  path: string;
  content_hash: string;
  indexed_at: string | null;
  status: MemoryFileStatus;
  created_at: string;
};

export type MemoryChunk = {
  id: string;
  file_id: string;
  start_line: number;
  end_line: number;
  content: string;
  hash: string;
  indexed_at: string;
};

const VALID_TRANSITIONS: Record<MemoryFileStatus, Set<MemoryFileStatus>> = {
  pending: new Set(['indexed', 'removed']),
  indexed: new Set(['pending', 'removed']),
  removed: new Set(),
};

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createMemoryFile(params: {
  group_id: string;
  path: string;
  content_hash: string;
  status: MemoryFileStatus;
  indexed_at: string | null;
}): MemoryFile {
  const id = generateId();
  const created_at = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO memory_files (id, group_id, path, content_hash, indexed_at, status, created_at)
       VALUES (@id, @group_id, @path, @content_hash, @indexed_at, @status, @created_at)`,
    )
    .run({ id, ...params, created_at });
  return { id, created_at, ...params };
}

export function getMemoryFile(id: string): MemoryFile | null {
  return (
    (getDb().prepare('SELECT * FROM memory_files WHERE id = ?').get(id) as MemoryFile | undefined) ?? null
  );
}

export function findMemoryFile(params: { group_id: string; path: string }): MemoryFile | null {
  return (
    (getDb()
      .prepare('SELECT * FROM memory_files WHERE group_id = ? AND path = ?')
      .get(params.group_id, params.path) as MemoryFile | undefined) ?? null
  );
}

export function getAllMemoryFiles(): MemoryFile[] {
  return getDb().prepare('SELECT * FROM memory_files').all() as MemoryFile[];
}

export function updateMemoryFile(
  id: string,
  updates: Partial<Pick<MemoryFile, 'status' | 'content_hash' | 'indexed_at'>>,
): void {
  const current = getMemoryFile(id);
  if (!current) throw new Error(`MemoryFile not found: ${id}`);

  if (updates.status !== undefined && updates.status !== current.status) {
    const allowed = VALID_TRANSITIONS[current.status];
    if (!allowed.has(updates.status)) {
      throw new Error(`Invalid status transition: ${current.status} -> ${updates.status}`);
    }
  }

  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE memory_files SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function createMemoryChunk(params: {
  file_id: string;
  start_line: number;
  end_line: number;
  content: string;
  hash: string;
  indexed_at: string;
}): MemoryChunk {
  const id = generateId();
  getDb()
    .prepare(
      `INSERT INTO memory_chunks (id, file_id, start_line, end_line, content, hash, indexed_at)
       VALUES (@id, @file_id, @start_line, @end_line, @content, @hash, @indexed_at)`,
    )
    .run({ id, ...params });
  return { id, ...params };
}

export function getMemoryFileChunks(file_id: string): MemoryChunk[] {
  return getDb()
    .prepare('SELECT * FROM memory_chunks WHERE file_id = ?')
    .all(file_id) as MemoryChunk[];
}

export function getAllMemoryChunks(): MemoryChunk[] {
  return getDb().prepare('SELECT * FROM memory_chunks').all() as MemoryChunk[];
}

export function deleteMemoryChunks(file_id: string): void {
  getDb().prepare('DELETE FROM memory_chunks WHERE file_id = ?').run(file_id);
}
