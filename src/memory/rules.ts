import {
  createMemoryChunk,
  createMemoryFile,
  deleteMemoryChunks,
  findMemoryFile,
  updateMemoryFile,
  type MemoryFile,
} from './db.js';

type ChunkResult = {
  start_line: number;
  end_line: number;
  content: string;
  hash: string;
};

/** The group's memory/ tree, or its Zettelkasten folder (see ZETTEL_DIR in manager.ts). */
const MEMORY_PATH_RE = /^groups\/[^/]+\/(memory|zettel)\//;

function assertMemoryPath(path: string): void {
  if (!MEMORY_PATH_RE.test(path)) {
    throw new Error(
      `Path violates MemoryFilesWithinWorkspace invariant — must be under groups/<folder>/memory/ or groups/<folder>/zettel/: ${path}`,
    );
  }
}

export async function handleWorkspaceFileChanged(params: {
  group_id: string;
  path: string;
  content_hash: string;
}): Promise<void> {
  assertMemoryPath(params.path);

  const existing = await findMemoryFile({ group_id: params.group_id, path: params.path });

  if (!existing) {
    // FileDiscovered: new file, create in pending state
    await createMemoryFile({
      group_id: params.group_id,
      path: params.path,
      content_hash: params.content_hash,
      status: 'pending',
      indexed_at: null,
    });
    return;
  }

  // FileUpdated: existing file
  if (existing.status === 'removed') return; // terminal — no transitions out
  if (existing.content_hash === params.content_hash) return; // no-op: hash unchanged

  await updateMemoryFile(existing.id, { status: 'pending', content_hash: params.content_hash });
}

export async function handleWorkspaceFileRemoved(params: { group_id: string; path: string }): Promise<void> {
  const file = await findMemoryFile({ group_id: params.group_id, path: params.path });
  if (!file) return; // file not tracked — no-op
  if (file.status === 'removed') return; // already terminal — no-op

  await deleteMemoryChunks(file.id);
  await updateMemoryFile(file.id, { status: 'removed' });
}

export async function syncPendingFile(
  file: MemoryFile,
  opts: {
    chunkFn: (path: string, tokens: number, overlap: number) => ChunkResult[];
    embedFn: (file: MemoryFile, chunks: ChunkResult[]) => Promise<void>;
  },
): Promise<void> {
  if (file.status !== 'pending') {
    throw new Error(`FileSynced requires pending status, got: ${file.status}`);
  }

  const newChunks = opts.chunkFn(file.path, 400, 80);

  await opts.embedFn(file, newChunks);

  // Replace existing chunks with the new set
  await deleteMemoryChunks(file.id);

  const now = new Date().toISOString();
  for (const c of newChunks) {
    await createMemoryChunk({
      file_id: file.id,
      start_line: c.start_line,
      end_line: c.end_line,
      content: c.content,
      hash: c.hash,
      indexed_at: now,
    });
  }

  await updateMemoryFile(file.id, { status: 'indexed', indexed_at: now });
}
