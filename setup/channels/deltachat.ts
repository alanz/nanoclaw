/**
 * DeltaChat channel flow for setup:auto.
 *
 * No token to collect — the account auto-provisions on nine.testrun.org
 * (or whichever relay is set via DELTACHAT_CHATMAIL_QR). The service was
 * already started before this step, so we just poll for the invite URL the
 * adapter writes to {dataDir}/invite-url once the account is online, then
 * show it so the operator can tap it in DeltaChat to establish a DM.
 */
import * as p from '@clack/prompts';
import fs from 'fs';
import os from 'os';
import path from 'path';
import k from 'kleur';

import { readEnvFile } from '../../src/env.js';
import { confirmThenOpen } from '../lib/browser.js';
import * as setupLog from '../logs.js';

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 30_000;

export async function runDeltachatChannel(_displayName: string): Promise<void> {
  const rawDataDir =
    readEnvFile(['DELTACHAT_DATA_DIR']).DELTACHAT_DATA_DIR ?? 'store/deltachat';
  const dataDir = path.resolve(rawDataDir.replace(/^~/, os.homedir()));
  const inviteUrlPath = path.join(dataDir, 'invite-url');

  const start = Date.now();
  const s = p.spinner();
  s.start('Waiting for your DeltaChat bot to come online…');

  const inviteUrl = await pollForFile(inviteUrlPath, POLL_TIMEOUT_MS, POLL_INTERVAL_MS);

  if (!inviteUrl) {
    s.stop('DeltaChat bot did not come online in time.', 1);
    p.log.warn('Check logs/nanoclaw.log for DeltaChat errors.');
    setupLog.step('deltachat-online', 'failed', Date.now() - start, { ERROR: 'timeout' });
    return;
  }

  s.stop('Your DeltaChat bot is ready.');
  setupLog.step('deltachat-online', 'success', Date.now() - start, {});

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
