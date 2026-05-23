/**
 * Workspace URL MCP tools: get_file_url, get_file_path.
 *
 * get_file_url  — convert a /workspace/... path to a shareable dashboard URL.
 * get_file_path — inverse: parse a dashboard URL back to a /workspace/... path.
 *
 * The base URL comes from /workspace/nanoclaw_meta.json, written by the host
 * at container spawn. The container never holds WEB_UI_BASE_URL as an env var
 * so the host can change it without rebuilding or restarting containers.
 *
 * Both tools return null / an error when WEB_UI_BASE_URL is not configured.
 */
import fs from 'fs';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

export const META_PATH = '/workspace/nanoclaw_meta.json';

interface NanoclawMeta {
  webUiBaseUrl: string | null;
  groupFolder: string;
}

export function readMeta(p = META_PATH): NanoclawMeta | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as NanoclawMeta;
  } catch {
    return null;
  }
}

export function buildFileUrl(webUiBaseUrl: string, groupFolder: string, filePath: string): string {
  let rel = filePath;
  // /workspace/agent/ maps to the group folder on the host — strip it so the
  // path is relative to the group folder, which is what the web UI expects.
  if (rel.startsWith('/workspace/agent/')) rel = rel.slice('/workspace/agent/'.length);
  else if (rel.startsWith('/workspace/')) rel = rel.slice('/workspace/'.length);
  rel = rel.replace(/^\/+/, '');
  return `${webUiBaseUrl}/#groups/${groupFolder}/files/${rel}`;
}

export function parseFileUrl(webUiBaseUrl: string, groupFolder: string, url: string): string | null {
  const prefix = `${webUiBaseUrl}/#groups/${groupFolder}/files/`;
  if (!url.startsWith(prefix)) return null;
  // Reconstruct as an agent workspace path (group folder = /workspace/agent/).
  return `/workspace/agent/${url.slice(prefix.length)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

export const getFileUrl: McpToolDefinition = {
  tool: {
    name: 'get_file_url',
    description:
      'Generate a shareable web dashboard URL for a file in the agent workspace. ' +
      'Use this whenever you reference a workspace file in a message, report, or document — ' +
      'prefer the URL over a raw file path. Returns null if WEB_UI_BASE_URL is not configured.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        file_path: {
          type: 'string',
          description: 'Absolute path to the file inside the container (e.g. /workspace/agent/notes.md)',
        },
      },
      required: ['file_path'],
    },
  },
  async handler(args) {
    const meta = readMeta();
    if (!meta?.webUiBaseUrl) {
      return err('WEB_UI_BASE_URL is not configured — set it in .env to enable workspace links');
    }
    const url = buildFileUrl(meta.webUiBaseUrl, meta.groupFolder, args.file_path as string);
    return ok(url);
  },
};

export const getFilePath: McpToolDefinition = {
  tool: {
    name: 'get_file_path',
    description:
      'Resolve a web dashboard URL back to an absolute file path inside the container workspace. ' +
      'Inverse of get_file_url.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'Dashboard URL previously returned by get_file_url',
        },
      },
      required: ['url'],
    },
  },
  async handler(args) {
    const meta = readMeta();
    if (!meta?.webUiBaseUrl) {
      return err('WEB_UI_BASE_URL is not configured');
    }
    const filePath = parseFileUrl(meta.webUiBaseUrl, meta.groupFolder, args.url as string);
    if (!filePath) {
      return err(`URL does not match this workspace: ${args.url as string}`);
    }
    return ok(filePath);
  },
};

registerTools([getFileUrl, getFilePath]);
