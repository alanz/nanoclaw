import { describe, expect, it } from 'vitest';

import { _parseSessionPostMortem } from './specialists.js';

const SESSION_ID = '32ba12db-7630-4775-8852-7e37e519f9b2';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

function assistantToolUse(name: string, input: unknown): string {
  return line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name, input }],
    },
  });
}

function toolResult(result: unknown): string {
  return line({
    type: 'user',
    toolUseResult: result,
    message: { role: 'user', content: [] },
  });
}

function apiError(text: string): string {
  return line({
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

function assistantText(text: string): string {
  return line({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

describe('_parseSessionPostMortem', () => {
  it('returns unavailable message for empty content', () => {
    const result = _parseSessionPostMortem(SESSION_ID, '');
    expect(result).toContain('0 turns');
  });

  it('includes last tool name and input', () => {
    const content = [
      assistantToolUse('WebFetch', {
        url: 'https://example.com',
        prompt: 'Extract text',
      }),
      toolResult({ code: 200, codeText: 'OK', bytes: 1234 }),
    ].join('\n');

    const result = _parseSessionPostMortem(SESSION_ID, content);
    expect(result).toContain('Last tool: WebFetch(');
    expect(result).toContain('https://example.com');
    expect(result).toContain('200 OK (1234 bytes)');
  });

  it('surfaces API policy errors', () => {
    const content = [
      assistantToolUse('brave_web_search', { query: 'wheat grainulation' }),
      toolResult([{ type: 'text', text: 'search result text here' }]),
      apiError(
        'Claude Code is unable to respond to this request, which appears to violate our Usage Policy.',
      ),
    ].join('\n');

    const result = _parseSessionPostMortem(SESSION_ID, content);
    expect(result).toContain('API error:');
    expect(result).toContain('Usage Policy');
    expect(result).toContain('Last tool: brave_web_search(');
  });

  it('shows bash stdout snippet when no http code', () => {
    const content = [
      assistantToolUse('Bash', { command: 'ls /workspace' }),
      toolResult({
        stdout: 'file1.txt\nfile2.txt\nfile3.txt',
        stderr: '',
        interrupted: false,
      }),
    ].join('\n');

    const result = _parseSessionPostMortem(SESSION_ID, content);
    expect(result).toContain('Last tool: Bash(');
    expect(result).toContain('file1.txt');
  });

  it('shows last assistant text when no tool was called', () => {
    const content = [assistantText('I have completed the analysis.')].join(
      '\n',
    );

    const result = _parseSessionPostMortem(SESSION_ID, content);
    expect(result).toContain('Last response: I have completed the analysis.');
  });

  it('does not show last response when a tool was called last', () => {
    const content = [
      assistantText('Starting research now.'),
      assistantToolUse('WebFetch', { url: 'https://example.com' }),
    ].join('\n');

    const result = _parseSessionPostMortem(SESSION_ID, content);
    expect(result).not.toContain('Last response:');
    expect(result).toContain('Last tool: WebFetch(');
  });

  it('truncates long tool inputs', () => {
    const longQuery = 'x'.repeat(200);
    const content = [assistantToolUse('Bash', { command: longQuery })].join(
      '\n',
    );

    const result = _parseSessionPostMortem(SESSION_ID, content);
    expect(result).toContain('…');
  });

  it('includes session id prefix and turn count in header', () => {
    const content = [
      assistantToolUse('WebFetch', { url: 'https://a.com' }),
      assistantToolUse('Bash', { command: 'ls' }),
    ].join('\n');

    const result = _parseSessionPostMortem(SESSION_ID, content);
    expect(result).toContain('32ba12db…');
    expect(result).toContain('2 turns');
  });
});
