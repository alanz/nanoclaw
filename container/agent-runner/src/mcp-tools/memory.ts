/**
 * Memory MCP tools: memory_search, memory_get_file_content, memory_list_files.
 *
 * These tools are only available in non-specialist containers. Specialist
 * containers are excluded via the conditional import in index.ts:
 *
 *   if (!isSpecialist) { await import('./memory.js'); }
 *
 * The host-side rule handlers (src/memory/search.ts) enforce actor restriction:
 * all three tools throw when session.agent_group_id !== group_id.
 *
 * The actual search and retrieval is performed by the host process (central DB).
 * The container writes a request via messages_out; the host responds on the
 * next inbound turn. For now, the tools are registered with the correct names
 * and schemas — the full request-response loop is wired in by the host-side
 * memory module when active.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

export const memorySearch: McpToolDefinition = {
  tool: {
    name: 'memory_search',
    description:
      'Search the agent group memory index using a natural language query. Returns ranked results from indexed markdown and org files.',
    inputSchema: {
      type: 'object' as const,
      required: ['group', 'query'],
      properties: {
        group: {
          type: 'string',
          description: 'The agent group folder name to search within.',
        },
        query: {
          type: 'string',
          description: 'Natural language search query.',
        },
        top_k: {
          type: 'number',
          description: 'Maximum number of results to return (default: 6).',
        },
      },
    },
  },
  async handler(args) {
    const query = args.query as string;
    const group = args.group as string;
    if (!query || !group) {
      return { content: [{ type: 'text' as const, text: 'Error: query and group are required' }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify([]) }] };
  },
};

export const memoryGetFileContent: McpToolDefinition = {
  tool: {
    name: 'memory_get_file_content',
    description:
      'Read the full content of a specific indexed memory file by path.',
    inputSchema: {
      type: 'object' as const,
      required: ['group', 'path'],
      properties: {
        group: {
          type: 'string',
          description: 'The agent group folder name.',
        },
        path: {
          type: 'string',
          description: 'Repo-relative path of the file to retrieve.',
        },
        parse_frontmatter: {
          type: 'boolean',
          description: 'Whether to parse and return YAML frontmatter (default: true).',
        },
      },
    },
  },
  async handler(args) {
    const path = args.path as string;
    const group = args.group as string;
    if (!path || !group) {
      return { content: [{ type: 'text' as const, text: 'Error: path and group are required' }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: 'Error: memory index not available in this container' }], isError: true };
  },
};

export const memoryListFiles: McpToolDefinition = {
  tool: {
    name: 'memory_list_files',
    description:
      'List indexed files in the agent group memory workspace.',
    inputSchema: {
      type: 'object' as const,
      required: ['group'],
      properties: {
        group: {
          type: 'string',
          description: 'The agent group folder name.',
        },
        path_prefix: {
          type: 'string',
          description: 'Restrict listing to files under this path prefix.',
        },
        source: {
          type: 'string',
          description: 'Restrict listing to files from a named source.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of files to return.',
        },
        order_by: {
          type: 'string',
          description: 'Sort order: mtime | path | size.',
        },
        parse_frontmatter: {
          type: 'boolean',
          description: 'Whether to parse and include YAML frontmatter (limit ≤ 50 when true).',
        },
      },
    },
  },
  async handler(args) {
    const group = args.group as string;
    if (!group) {
      return { content: [{ type: 'text' as const, text: 'Error: group is required' }], isError: true };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify([]) }] };
  },
};

registerTools([memorySearch, memoryGetFileContent, memoryListFiles]);
