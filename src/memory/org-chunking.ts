import type { MemoryChunk } from './internal.js';
import { hashText } from './internal.js';

/**
 * Org-mode structural element types
 */
type OrgElementType =
  | 'heading'
  | 'property-drawer'
  | 'block'
  | 'drawer'
  | 'content';

/**
 * Represents a parsed org-mode structural element
 */
interface OrgElement {
  type: OrgElementType;
  level?: number; // For headings: number of asterisks
  startLine: number;
  endLine: number;
  text: string;
}

/**
 * Parse org-mode content into structural elements.
 */
export function parseOrgStructure(content: string): OrgElement[] {
  const lines = content.split('\n');
  const elements: OrgElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // Detect heading: /^\*+ /
    const headingMatch = line.match(/^(\*+)\s+(.*)$/);
    if (headingMatch) {
      elements.push({
        type: 'heading',
        level: headingMatch[1].length,
        startLine: i + 1,
        endLine: i + 1,
        text: line,
      });
      i += 1;
      continue;
    }

    // Detect property drawer: :PROPERTIES:
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

    // Detect general drawer: :NAME:
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

    // Detect block: #+BEGIN_*
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

    // Regular content line
    elements.push({
      type: 'content',
      startLine: i + 1,
      endLine: i + 1,
      text: line,
    });
    i += 1;
  }

  return elements;
}

function findEndMarker(
  lines: string[],
  startIdx: number,
  marker: string,
  caseInsensitive = false,
): number {
  const searchMarker = caseInsensitive ? marker.toUpperCase() : marker;

  for (let i = startIdx; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    const comparison = caseInsensitive ? trimmed.toUpperCase() : trimmed;

    if (comparison === searchMarker) {
      return i;
    }
  }

  return -1;
}

/**
 * Chunk org-mode content with awareness of structural elements.
 */
export function chunkOrgMode(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const elements = parseOrgStructure(content);
  const maxChars = Math.max(32, chunking.tokens * 4);
  const chunks: MemoryChunk[] = [];

  let headingStack: OrgElement[] = [];
  let currentElements: OrgElement[] = [];
  let currentSize = 0;

  const flushChunk = () => {
    if (currentElements.length === 0) {
      return;
    }

    const parts: string[] = [];

    if (headingStack.length > 0 && currentElements[0]?.type !== 'heading') {
      parts.push(headingStack.map((h) => h.text).join('\n'));
      parts.push('');
    }

    parts.push(currentElements.map((e) => e.text).join('\n'));

    const text = parts.join('\n');
    const firstElement = currentElements[0];
    const lastElement = currentElements[currentElements.length - 1];

    if (!firstElement || !lastElement) {
      return;
    }

    chunks.push({
      startLine: firstElement.startLine,
      endLine: lastElement.endLine,
      text,
      hash: hashText(text),
    });

    currentElements = [];
    currentSize = 0;
  };

  for (const element of elements) {
    const elementSize = element.text.length + 1;

    if (element.type === 'heading') {
      const level = element.level ?? 0;
      headingStack = headingStack.filter((h) => (h.level ?? 0) < level);
      headingStack.push(element);

      if (currentSize > maxChars * 0.5 && currentElements.length > 0) {
        flushChunk();
      }
    }

    if (
      element.type === 'block' ||
      element.type === 'drawer' ||
      element.type === 'property-drawer'
    ) {
      if (currentSize + elementSize > maxChars && currentElements.length > 0) {
        flushChunk();
      }

      currentElements.push(element);
      currentSize += elementSize;
      continue;
    }

    if (currentSize + elementSize > maxChars && currentElements.length > 0) {
      flushChunk();
    }

    currentElements.push(element);
    currentSize += elementSize;
  }

  flushChunk();

  return chunks;
}
