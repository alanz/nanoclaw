import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

// The unit tests drive ensureMemoryScaffold directly and stay green if the boot
// call is deleted. main() can't be driven in-process (it reads
// /workspace/agent/container.json and enters the poll loop), so the guard is
// structural: call + import must both be present in the real entry point.
describe('memory scaffold boot wiring', () => {
  const indexSrc = fs.readFileSync(path.join(import.meta.dir, '..', 'index.ts'), 'utf-8');

  // Specialists mount /workspace/agent read-only, so scaffolding there throws
  // EROFS and kills the runner before it ever polls — every specialist task
  // then hangs until the 4h dispatch timeout. The gate must stay in place, and
  // must key off the host-supplied flag rather than an agent-group-id prefix
  // (specialist ids carry no fixed prefix).
  it('scaffolds memory in main(), gated on non-specialist', () => {
    expect(indexSrc).toMatch(/\n\s*if \(!config\.isSpecialist\) ensureMemoryScaffold\(\);/);
  });

  it('does not infer specialist status from the agent group id', () => {
    expect(indexSrc).not.toContain('ag-specialist-');
  });

  it('imports ensureMemoryScaffold from the seam module', () => {
    expect(indexSrc).toContain("import { ensureMemoryScaffold } from './memory/scaffold.js'");
  });
});
