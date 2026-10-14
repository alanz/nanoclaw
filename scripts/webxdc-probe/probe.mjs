// Phase 0 WebXDC probe: can the bot push a status update into an app that has
// never sent one? Runs on the bot's own account while the NanoClaw host is
// stopped (only one process may hold the account).
//
// Commands, one per line appended to ./cmd:
//   send            send probe.xdc to the chat (records its msgId)
//   update <text>   push a status update into the probe instance
//   read            log every status update the bot can see for the instance
//   quit            stop IO and exit
import fs from 'fs';
import path from 'path';
import { startDeltaChat } from '@deltachat/stdio-rpc-server';

const HERE = path.resolve(process.env.PROBE_DIR || 'data/webxdc-probe');
const DATA = process.env.DELTACHAT_DATA_DIR || path.resolve('store/deltachat');
const CHAT = Number(process.env.PROBE_CHAT_ID || 10); // the DeltaChat chat id (platformId dc:<id>)
const CMD = path.join(HERE, 'cmd');
const STATE = path.join(HERE, 'state.json');
const LOG = path.join(HERE, 'probe.log');

const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
};

const dc = await startDeltaChat(DATA);
const acc = (await dc.rpc.getAllAccounts())[0].id;
const ev = dc.getContextEvents(acc);
for (const name of [
  'WebxdcStatusUpdate',
  'WebxdcInstanceDeleted',
  'WebxdcRealtimeData',
  'WebxdcRealtimeAdvertisementReceived',
  'MsgDelivered',
  'MsgFailed',
  'SmtpMessageSent',
  'Error',
  'Warning',
]) {
  ev.on(name, (e) => log('event', name, e));
}
await dc.rpc.startIo(acc);
log('started; account', acc);

let state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
let n = 0;
fs.writeFileSync(CMD, '');
let done = 0;

async function run(line) {
  const [cmd, ...rest] = line.trim().split(' ');
  if (cmd === 'send') {
    const msgId = await dc.rpc.sendMsg(acc, CHAT, {
      text: 'Phase 0 probe: please open this app (it only listens).',
      html: null,
      viewtype: null,
      file: path.join(HERE, 'probe.xdc'),
      filename: 'probe.xdc',
      location: null,
      overrideSenderName: null,
      quotedMessageId: null,
      quotedText: null,
    });
    state = { msgId };
    fs.writeFileSync(STATE, JSON.stringify(state));
    log('sent app, msgId', msgId);
  } else if (cmd === 'update') {
    const text = rest.join(' ') || `update ${++n}`;
    const sentAt = new Date().toISOString();
    await dc.rpc.sendWebxdcStatusUpdate(
      acc,
      state.msgId,
      JSON.stringify({ payload: { from: 'bot', text, sentAt }, notify: { '*': `Probe: ${text}` } }),
      '',
    );
    log('pushed update', { text, sentAt });
  } else if (cmd === 'text') {
    const id = await dc.rpc.miscSendTextMessage(acc, CHAT, rest.join(' ') || 'probe text');
    log('sent text, msgId', id);
  } else if (cmd === 'read') {
    log('updates', JSON.parse(await dc.rpc.getWebxdcStatusUpdates(acc, state.msgId, 0)));
  } else if (cmd === 'quit') {
    await dc.rpc.stopIo(acc);
    log('stopped');
    dc.close();
    process.exit(0);
  }
}

setInterval(async () => {
  const lines = fs.readFileSync(CMD, 'utf8').split('\n').filter(Boolean);
  while (done < lines.length) {
    const line = lines[done++];
    try {
      await run(line);
    } catch (err) {
      log('command failed', line, String(err));
    }
  }
}, 500);
