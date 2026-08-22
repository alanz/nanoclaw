import { getDb } from '../db/connection.js';
// The module owns these tables, so it owns registering their migration —
// importing db.ts is what makes memory_files/memory_chunks exist.
import '../db/migrations/module-memory.js';

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

export async function createMemoryFile(params: {
  group_id: string;
  path: string;
  content_hash: string;
  status: MemoryFileStatus;
  indexed_at: string | null;
}): Promise<MemoryFile> {
  const id = generateId();
  const created_at = new Date().toISOString();
  await getDb().run(
    `INSERT INTO memory_files (id, group_id, path, content_hash, indexed_at, status, created_at)
     VALUES (@id, @group_id, @path, @content_hash, @indexed_at, @status, @created_at)`,
    { id, ...params, created_at },
  );
  return { id, created_at, ...params };
}

export async function getMemoryFile(id: string): Promise<MemoryFile | null> {
  return (await getDb().get<MemoryFile>('SELECT * FROM memory_files WHERE id = ?', id)) ?? null;
}

export async function findMemoryFile(params: { group_id: string; path: string }): Promise<MemoryFile | null> {
  return (
    (await getDb().get<MemoryFile>(
      'SELECT * FROM memory_files WHERE group_id = ? AND path = ?',
      params.group_id,
      params.path,
    )) ?? null
  );
}

export async function getAllMemoryFiles(): Promise<MemoryFile[]> {
  return getDb().all<MemoryFile>('SELECT * FROM memory_files');
}

export async function updateMemoryFile(
  id: string,
  updates: Partial<Pick<MemoryFile, 'status' | 'content_hash' | 'indexed_at'>>,
): Promise<void> {
  const current = await getMemoryFile(id);
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

  await getDb().run(`UPDATE memory_files SET ${fields.join(', ')} WHERE id = @id`, values);
}

export async function createMemoryChunk(params: {
  file_id: string;
  start_line: number;
  end_line: number;
  content: string;
  hash: string;
  indexed_at: string;
}): Promise<MemoryChunk> {
  const id = generateId();
  await getDb().run(
    `INSERT INTO memory_chunks (id, file_id, start_line, end_line, content, hash, indexed_at)
     VALUES (@id, @file_id, @start_line, @end_line, @content, @hash, @indexed_at)`,
    { id, ...params },
  );
  return { id, ...params };
}

export async function getMemoryFileChunks(file_id: string): Promise<MemoryChunk[]> {
  return getDb().all<MemoryChunk>('SELECT * FROM memory_chunks WHERE file_id = ?', file_id);
}

export async function getAllMemoryChunks(): Promise<MemoryChunk[]> {
  return getDb().all<MemoryChunk>('SELECT * FROM memory_chunks');
}

export async function deleteMemoryChunks(file_id: string): Promise<void> {
  await getDb().run('DELETE FROM memory_chunks WHERE file_id = ?', file_id);
}
