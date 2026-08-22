import crypto from 'node:crypto';

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

export function hashText(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function chunkMarkdown(content: string, chunking: { tokens: number; overlap: number }): MemoryChunk[] {
  const lines = content.split('\n');
  if (lines.length === 0) return [];

  const maxChars = Math.max(32, chunking.tokens * 4);
  const overlapChars = Math.max(0, chunking.overlap * 4);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const firstEntry = current[0];
    const lastEntry = current[current.length - 1];
    if (!firstEntry || !lastEntry) return;
    const text = current.map((entry) => entry.line).join('\n');
    chunks.push({ startLine: firstEntry.lineNo, endLine: lastEntry.lineNo, text, hash: hashText(text) });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      if (!entry) continue;
      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineNo = i + 1;
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push('');
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }
    for (const segment of segments) {
      const lineSize = segment.length + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }
  flush();
  return chunks;
}

// ---- Org-mode chunking ----

type OrgElementType = 'heading' | 'property-drawer' | 'block' | 'drawer' | 'content';

interface OrgElement {
  type: OrgElementType;
  level?: number;
  startLine: number;
  endLine: number;
  text: string;
}

function findEndMarker(lines: string[], startIdx: number, marker: string, caseInsensitive = false): number {
  const searchMarker = caseInsensitive ? marker.toUpperCase() : marker;
  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    const comparison = caseInsensitive ? trimmed.toUpperCase() : trimmed;
    if (comparison === searchMarker) return i;
  }
  return -1;
}

function parseOrgStructure(content: string): OrgElement[] {
  const lines = content.split('\n');
  const elements: OrgElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    const headingMatch = line.match(/^(\*+)\s+(.*)$/);
    if (headingMatch) {
      elements.push({ type: 'heading', level: headingMatch[1].length, startLine: i + 1, endLine: i + 1, text: line });
      i += 1;
      continue;
    }

    if (trimmed === ':PROPERTIES:') {
      const endIdx = findEndMarker(lines, i + 1, ':END:');
      if (endIdx !== -1) {
        elements.push({
          type: 'property-drawer',
          startLine: i + 1,
          endLine: endIdx + 1,
          text: lines.slice(i, endIdx + 1).join('\n'),
        });
        i = endIdx + 1;
        continue;
      }
    }

    const drawerMatch = trimmed.match(/^:([A-Z][A-Z0-9_-]*):$/);
    if (drawerMatch && drawerMatch[1] !== 'END') {
      const endIdx = findEndMarker(lines, i + 1, ':END:');
      if (endIdx !== -1) {
        elements.push({
          type: 'drawer',
          startLine: i + 1,
          endLine: endIdx + 1,
          text: lines.slice(i, endIdx + 1).join('\n'),
        });
        i = endIdx + 1;
        continue;
      }
    }

    const blockMatch = trimmed.match(/^#\+BEGIN_(\w+)/i);
    if (blockMatch) {
      const blockType = blockMatch[1].toUpperCase();
      const endIdx = findEndMarker(lines, i + 1, `#+END_${blockType}`, true);
      if (endIdx !== -1) {
        elements.push({
          type: 'block',
          startLine: i + 1,
          endLine: endIdx + 1,
          text: lines.slice(i, endIdx + 1).join('\n'),
        });
        i = endIdx + 1;
        continue;
      }
    }

    elements.push({ type: 'content', startLine: i + 1, endLine: i + 1, text: line });
    i += 1;
  }

  return elements;
}

export function chunkOrgMode(content: string, chunking: { tokens: number; overlap: number }): MemoryChunk[] {
  const elements = parseOrgStructure(content);
  const maxChars = Math.max(32, chunking.tokens * 4);
  const chunks: MemoryChunk[] = [];

  let headingStack: OrgElement[] = [];
  let currentElements: OrgElement[] = [];
  let currentSize = 0;

  const flushChunk = () => {
    if (currentElements.length === 0) return;
    const parts: string[] = [];
    if (headingStack.length > 0 && currentElements[0]?.type !== 'heading') {
      parts.push(headingStack.map((h) => h.text).join('\n'));
      parts.push('');
    }
    parts.push(currentElements.map((e) => e.text).join('\n'));
    const text = parts.join('\n');
    const firstElement = currentElements[0];
    const lastElement = currentElements[currentElements.length - 1];
    if (!firstElement || !lastElement) return;
    chunks.push({ startLine: firstElement.startLine, endLine: lastElement.endLine, text, hash: hashText(text) });
    currentElements = [];
    currentSize = 0;
  };

  for (const element of elements) {
    const elementSize = element.text.length + 1;

    if (element.type === 'heading') {
      const level = element.level ?? 0;
      headingStack = headingStack.filter((h) => (h.level ?? 0) < level);
      headingStack.push(element);
      if (currentSize > maxChars * 0.5 && currentElements.length > 0) flushChunk();
    }

    if (element.type === 'block' || element.type === 'drawer' || element.type === 'property-drawer') {
      if (currentSize + elementSize > maxChars && currentElements.length > 0) flushChunk();
      currentElements.push(element);
      currentSize += elementSize;
      continue;
    }

    if (currentSize + elementSize > maxChars && currentElements.length > 0) flushChunk();
    currentElements.push(element);
    currentSize += elementSize;
  }

  flushChunk();
  return chunks;
}

/** Dispatch to the appropriate chunker based on file extension. */
export function chunkFile(
  filePath: string,
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  if (filePath.endsWith('.org')) return chunkOrgMode(content, chunking);
  return chunkMarkdown(content, chunking);
}
