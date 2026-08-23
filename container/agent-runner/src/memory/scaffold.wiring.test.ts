import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

// The unit tests drive ensureMemoryScaffold directly and stay green if the boot
// call is deleted. main() can't be driven in-process (it reads
// /workspace/agent/container.json and enters the poll loop), so the guard is
// structural: call + import must both be present in the real entry point.
describe('memory scaffold boot wiring', () => {
  const indexSrc = fs.readFileSync(path.join(import.meta.dir, '..', 'index.ts'), 'utf-8');

  // A read-only workspace (a specialist's shared template folder) makes the
  // scaffold throw EROFS and kills the runner before it ever polls — every task
  // on it then hangs until the dispatch timeout. The gate must stay, and must
  // key off the host-supplied flag: the host decides the mount and the flag
  // together, so they cannot disagree.
  it('scaffolds memory in main(), except into a read-only workspace', () => {
    expect(indexSrc).toMatch(/\n\s*if \(process\.env\.NANOCLAW_WORKSPACE_READONLY !== '1'\) ensureMemoryScaffold\(\);/);
  });

  it('does not infer read-only or specialist status from the agent group id', () => {
    // Specialist ids carry no fixed prefix; a prefix check silently never matches.
    expect(indexSrc).not.toContain('ag-specialist-');
  });

  it('clears the continuation when the host asks for a fresh conversation', () => {
    expect(indexSrc).toMatch(
      /if \(process\.env\.NANOCLAW_FRESH_CONVERSATION === '1'\) \{[\s\S]*?clearContinuation\(providerName\);/,
    );
  });

  it('imports ensureMemoryScaffold from the seam module', () => {
    expect(indexSrc).toContain("import { ensureMemoryScaffold } from './memory/scaffold.js'");
  });
});
