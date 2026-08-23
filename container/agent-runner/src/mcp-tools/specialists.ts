/**
 * Specialist MCP tools — available inside specialist and main-group containers.
 *
 *   dispatch_specialist      — main group dispatches a root specialist task
 *   dispatch_sub_task        — specialist delegates work to another specialist
 *   deliver_specialist_result — specialist delivers its final answer
 *
 * All three are fire-and-forget: they write a system row to outbound.db
 * and return immediately. The host delivery loop picks them up and handles the
 * state transitions.
 *
 * dispatch_sub_task is semantically "exit after this call": the specialist
 * should return its tool result and end its turn. The result of the sub-task
 * will arrive as a new inbound message on the next invocation.
 *
 * deliver_specialist_result is always the last call a specialist makes in a
 * turn. The host marks the task completed and routes the result to the
 * requester.
 */
import { writeMessageOut } from '../db/messages-out.js';
import { requestShutdown } from '../shutdown.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function generateId(): string {
  return `spec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const dispatchSpecialist: McpToolDefinition = {
  tool: {
    name: 'dispatch_specialist',
    description:
      'Dispatch a specialist agent to work on a task. Only callable by the main agent group. ' +
      'The specialist runs in its own container session; the result is delivered back as a follow-up message. ' +
      'Returns immediately — do not block waiting for the result.',
    inputSchema: {
      type: 'object' as const,
      required: ['specialist_group_id', 'prompt'],
      properties: {
        specialist_group_id: {
          type: 'string',
          description: 'The ID of the specialist agent group to dispatch.',
        },
        prompt: {
          type: 'string',
          description: 'The task prompt to give the specialist.',
        },
      },
    },
  },
  async handler(args) {
    const specialistGroupId = args.specialist_group_id as string;
    const prompt = args.prompt as string;

    if (!specialistGroupId || typeof specialistGroupId !== 'string') {
      return err('specialist_group_id is required');
    }
    if (!prompt || typeof prompt !== 'string') {
      return err('prompt is required');
    }

    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'dispatch_specialist',
        specialist_group_id: specialistGroupId,
        prompt,
      }),
    });

    return ok(`Specialist task dispatched to "${specialistGroupId}". The result will arrive as a follow-up message.`);
  },
};

const dispatchSubTask: McpToolDefinition = {
  tool: {
    name: 'dispatch_sub_task',
    description:
      'Delegate work to another specialist agent. ' +
      'The sub-task runs in its own container session. After calling this tool, end your current turn — ' +
      'the sub-task result will arrive as a new message in your next invocation. ' +
      'Chain limits apply: depth, total delegations, and same-type repeat counts are enforced by the host.',
    inputSchema: {
      type: 'object' as const,
      required: ['specialist_group_id', 'prompt'],
      properties: {
        specialist_group_id: {
          type: 'string',
          description: 'The ID of the specialist agent group to dispatch to.',
        },
        prompt: {
          type: 'string',
          description: 'The task prompt to give the sub-specialist.',
        },
      },
    },
  },
  async handler(args) {
    const specialistGroupId = args.specialist_group_id as string;
    const prompt = args.prompt as string;

    if (!specialistGroupId || typeof specialistGroupId !== 'string') {
      return err('specialist_group_id is required');
    }
    if (!prompt || typeof prompt !== 'string') {
      return err('prompt is required');
    }

    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'dispatch_sub_task',
        specialist_group_id: specialistGroupId,
        prompt,
      }),
    });

    requestShutdown();
    return ok(
      `Sub-task dispatched to "${specialistGroupId}". End your turn now — the result will arrive in your next invocation.`,
    );
  },
};

const deliverSpecialistResult: McpToolDefinition = {
  tool: {
    name: 'deliver_specialist_result',
    description:
      'Deliver your final result back to the agent that dispatched you. ' +
      'Call this as the last action in your turn. The host will mark your task as complete and route the result to your requester.',
    inputSchema: {
      type: 'object' as const,
      required: ['result_text'],
      properties: {
        result_text: {
          type: 'string',
          description: 'Your final result text.',
        },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Paths of files to hand over to the requester, relative to /workspace/ipc-out/. Use paths like /workspace/ipc-out/report.pdf.',
        },
        commit_to_memory: {
          type: 'boolean',
          description:
            'When true and this is a root task, copy files to the requester group memory area instead of staging to ipc-in. Silently degraded to false for sub-tasks.',
        },
      },
    },
  },
  async handler(args) {
    const resultText = args.result_text as string;

    if (!resultText || typeof resultText !== 'string') {
      return err('result_text is required');
    }

    const filePaths = (args.file_paths ?? []) as string[];
    const commitToMemory = Boolean(args.commit_to_memory);

    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'deliver_specialist_result',
        result_text: resultText,
        file_paths: filePaths,
        commit_to_memory: commitToMemory,
      }),
    });

    requestShutdown();
    return ok('Result delivered. Your task is complete — do not take any further actions.');
  },
};

registerTools([dispatchSpecialist, dispatchSubTask, deliverSpecialistResult]);
