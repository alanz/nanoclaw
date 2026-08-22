/**
 * DeltaChat channel flow for setup:auto.
 *
 * No token to collect — the account auto-provisions on nine.testrun.org
 * (or whichever relay is set via DELTACHAT_CHATMAIL_QR). The service was
 * already started before this step, so we just poll for the invite URL the
 * adapter writes to {dataDir}/invite-url once the account is online, then
 * show it so the operator can tap it in DeltaChat to establish a DM.
 *
 * After the invite is opened we poll for {dataDir}/first-contact, which the
 * adapter writes when the first inbound DM arrives. That gives us the
 * owner's DC address and chatId so we can wire the agent via init-first-agent.
 */
import * as p from '@clack/prompts';
import fs from 'fs';
import os from 'os';
import path from 'path';
import k from 'kleur';

import { readEnvFile } from '../../src/env.js';
import { confirmThenOpen } from '../lib/browser.js';
import * as setupLog from '../logs.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';

const DEFAULT_AGENT_NAME = 'Nano';
const INVITE_POLL_TIMEOUT_MS = 30_000;
const FIRST_CONTACT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

export async function runDeltachatChannel(displayName: string): Promise<void> {
  const rawDataDir =
    readEnvFile(['DELTACHAT_DATA_DIR']).DELTACHAT_DATA_DIR ?? 'store/deltachat';
  const dataDir = path.resolve(rawDataDir.replace(/^~/, os.homedir()));

  // ── 1. Wait for the adapter to come online ────────────────────────────

  const inviteStart = Date.now();
  const s = p.spinner();
  s.start('Waiting for your DeltaChat bot to come online…');

  const inviteUrl = await pollForFile(
    path.join(dataDir, 'invite-url'),
    INVITE_POLL_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );

  if (!inviteUrl) {
    s.stop('DeltaChat bot did not come online in time.', 1);
    p.log.warn('Check logs/nanoclaw.log for DeltaChat errors.');
    setupLog.step('deltachat-online', 'failed', Date.now() - inviteStart, { ERROR: 'timeout' });
    return;
  }

  s.stop('Your DeltaChat bot is ready.');
  setupLog.step('deltachat-online', 'success', Date.now() - inviteStart, {});

  // ── 2. Show invite URL ────────────────────────────────────────────────

  p.note(
    [
      'Tap this link in DeltaChat to start your first conversation:',
      '',
      k.cyan(inviteUrl),
      '',
      k.dim('Or: DeltaChat → ≡ → New Chat → Scan QR Code'),
    ].join('\n'),
    'Connect DeltaChat',
  );

  await confirmThenOpen(inviteUrl, 'Press Enter to open in DeltaChat');
  setupLog.userInput('deltachat_invite_opened', 'true');

  // ── 3. Wait for first message ─────────────────────────────────────────

  const contactStart = Date.now();
  const s2 = p.spinner();
  s2.start('Waiting for your first message…');

  const firstContactJson = await pollForFile(
    path.join(dataDir, 'first-contact'),
    FIRST_CONTACT_TIMEOUT_MS,
    POLL_INTERVAL_MS,
  );

  if (!firstContactJson) {
    s2.stop("Didn't receive a first message in time.", 1);
    p.log.warn(
      'Send any message from DeltaChat, then re-run setup to finish wiring your assistant.',
    );
    setupLog.step('deltachat-first-contact', 'failed', Date.now() - contactStart, {
      ERROR: 'timeout',
    });
    return;
  }

  s2.stop('First message received.');
  setupLog.step('deltachat-first-contact', 'success', Date.now() - contactStart, {});

  const { addr, chatId, displayName: contactDisplayName } = JSON.parse(firstContactJson) as {
    addr: string;
    chatId: string;
    displayName: string;
  };

  // ── 4. Ask for agent name then wire ──────────────────────────────────

  const agentName = await resolveAgentName();

  const init = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', 'deltachat',
      '--user-id', `dc:${addr}`,
      '--platform-id', `dc:${chatId}`,
      '--display-name', contactDisplayName || displayName,
      '--agent-name', agentName,
      '--role', 'owner',
    ],
    {
      running: `Wiring ${agentName} to your DeltaChat…`,
      done: `${agentName} is ready. Check DeltaChat for a welcome message.`,
    },
    {
      extraFields: { CHANNEL: 'deltachat', AGENT_NAME: agentName },
    },
  );

  if (!init.ok) {
    await fail(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later with `/manage-channels`.',
    );
  }
}

async function resolveAgentName(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_NAME?.trim();
  if (preset) {
    setupLog.userInput('agent_name', preset);
    return preset;
  }
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your assistant be called?',
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  );
  const value = (answer as string).trim() || DEFAULT_AGENT_NAME;
  setupLog.userInput('agent_name', value);
  return value;
}

async function pollForFile(
  filePath: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content) return content;
    } catch {
      // file not yet written — keep polling
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}
