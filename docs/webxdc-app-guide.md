# Building a WebXDC App for NanoClaw

Hard-won lessons from building the Todo WebXDC app. Follow this exactly or you will spend days debugging.

---

## The mandatory script tag

Every WebXDC app must load DeltaChat's API via:

```html
<script src="webxdc.js"></script>
```

Put it in `<head>` **before** any app script. DeltaChat intercepts this specific request and serves its own implementation. Without it, `window.webxdc` is never defined and the app silently does nothing. This is not documented prominently anywhere.

---

## Initialisation pattern

DeltaChat may inject `window.webxdc` asynchronously. Poll for it before doing anything:

```javascript
var attempts = 0;
function initWebxdc() {
  attempts++;
  if (typeof window.webxdc === 'undefined') {
    if (attempts < 20) setTimeout(initWebxdc, 300); // retry up to 6s
    else /* give up */;
    return;
  }
  // Safe to use window.webxdc from here
  setupRealtimeChannel();
  setupUpdateListener();
  setupPingInterval();
}
initWebxdc();
```

Do **not** call any `window.webxdc.*` method at the top level of the script. It will silently fail.

---

## Communication architecture

NanoClaw uses two delivery paths to push updates to WebXDC apps:

### 1. Realtime (P2P, near-instant)
`sendWebxdcRealtimeData` — fire-and-forget. Fast when the app is open but gives no delivery confirmation.

### 2. Email fallback (reliable)
`sendWebxdcStatusUpdate` — sends an actual email. Survives app close/reopen. Updates appear via `setUpdateListener` replay on next open.

Updates are enqueued on the host and drained via **both paths** simultaneously. The queue persists across restarts.

---

## DC subscription requirement

DeltaChat only sends status-update **emails** from the host once the user's device has sent at least one `sendUpdate` for that message ID (the "subscription" signal). Until a ping arrives from the app, `sendWebxdcStatusUpdate` on the host side stores the update locally but **does not email it**.

**Consequence:** the app must send a signal early so the host knows someone is listening.

---

## The correct startup sequence (copy nanoclaw.xdc exactly)

```javascript
function initWebxdc() {
  // 1. Open realtime channel FIRST and send {type:'ready'}
  //    This triggers the host's WebxdcRealtimeData handler to drain the queue immediately
  try {
    var rt = window.webxdc.joinRealtimeChannel();
    rt.setListener(function(data) { handlePayload(JSON.parse(decode(data))); });
    rt.send(encode(JSON.stringify({ type: 'ready' })));
  } catch (_) {}

  // 2. Replay all stored updates, then ping for any queued since last open
  window.webxdc.setUpdateListener(function(update) {
    handlePayload(update.payload);
  }, 0).then(function() {
    window.webxdc.sendUpdate({ payload: { type: 'ping' } }, '');
  }).catch(function() {
    // Older DC clients don't return a Promise — interval fallback covers this
  });

  // 3. Re-ping on foreground resume (Android back-to-app)
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      window.webxdc.sendUpdate({ payload: { type: 'ping' } }, '');
    }
  });

  // 4. 30-second poll fallback — register OUTSIDE any try/catch so it always runs
  setInterval(function() {
    window.webxdc.sendUpdate({ payload: { type: 'ping' } }, '');
  }, 30000);
}
```

The order matters:
- **Realtime before listener** — establishes P2P channel before replay starts
- **`{type:'ready'}` via realtime** — triggers host's `WebxdcRealtimeData` handler which drains the queue
- **Ping after `.then()`** — fires after replay completes, drains queue via email fallback
- **Interval outside try/catch** — guarantees it's always registered even if the Promise path throws

---

## NanoClaw payload format

The host wraps agent responses in a NanoClaw envelope:

```json
{
  "type": "message",
  "content": "<agent output as string>",
  "title": "Andy",
  "timestamp": 1234567890
}
```

For structured data (like todo state), the agent puts JSON inside `content`:

```json
{
  "type": "message",
  "content": "{\"type\":\"state\",\"items\":[...]}",
  "title": "Andy",
  "timestamp": 1234567890
}
```

The app must parse `content` as JSON to get the inner structure. There is no way to send a raw payload directly from the agent — it always goes through this wrapper.

### System payload types (handle or ignore)

| `type` | Meaning |
|--------|---------|
| `ping` | Echo from another participant — ignore |
| `up_to_date` | Host queue was empty — no new content |
| `meta` | Session info: `{ msgId, timestamp }` — use for footer ID |
| `user_echo` | Echo of the user's own message — nanoclaw.xdc uses this |
| `clear` | Reset the feed — nanoclaw.xdc clears its card list |

---

## Named sessions (multiple .xdc apps per chat)

NanoClaw supports multiple WebXDC apps in the same chat via named sessions.

The webxdc store keys sessions as `"jid"` (nanoclaw.xdc) and `"jid:sessionName"` (other apps).

To push state to a named session from the agent:

```
webxdc_update(content=..., session_name="todo")
```

The host looks up `getActiveWebxdcMsgId("dc:10:todo")` and routes to that message.

### Sending a named app to the chat

Add a `/command` handler in `src/channels/deltachat.ts`:

```typescript
if (text.trim() === '/myapp') {
  await this.sendMyApp(jid);
  return;
}
```

In `sendMyApp`:
1. `sendMsg(...)` — sends the .xdc file, gets `msgId`
2. `setActiveWebxdcSession('jid:myapp', msgId)` — registers the session key
3. `sendWebxdcStatusUpdate(aid, msgId, metaJson, 'meta')` — push meta immediately so it's in replay
4. `onMessage(jid, syntheticMessage)` — trigger agent to push initial state

### Host-side host changes needed

- `src/types.ts` — add `session_name?: string` to `sendWebxdcUpdate`
- `src/ipc.ts` — pass `sessionName` through `processWebxdcUpdateIpc`
- `src/channels/deltachat.ts` — extend `sendWebxdcUpdate(jid, payload, sessionName?)` to use composite key
- `container/agent-runner/src/ipc-mcp-stdio.ts` — add `session_name` param to `webxdc_update` tool
- Add `/command` handler and `sendXxxApp()` method to `DeltaChatChannel`
- Add command to `/help` output

---

## File structure for a new .xdc app

```
apps/my-app/
  index.html        # self-contained, no external deps (CSP blocks them)
  manifest.toml     # name = "My App" + source_code_url
scripts/
  build-my-app-xdc.sh  # zips apps/my-app/ into assets/my-app.xdc
```

`manifest.toml`:
```toml
name = "My App"
source_code_url = "https://github.com/alanz/nanoclaw"
```

Build script (see `scripts/build-todo-xdc.sh` for the template).

Add to `package.json` scripts: `"build:my-app-xdc": "bash scripts/build-my-app-xdc.sh"`.

---

## CSP restrictions inside WebXDC

All external network requests are blocked. This means:

- No `<img src="https://...">` — embed images as base64 data URIs (use `webxdc_send_image` tool)
- No external JS/CSS libraries — bundle everything inline
- No external links that navigate — they will fail silently or show a CSP error on mobile
- No `fetch()` to external URLs

---

## Checklist for a new WebXDC app

- [ ] `<script src="webxdc.js"></script>` in `<head>`
- [ ] All `window.webxdc.*` calls inside `initWebxdc()` with polling
- [ ] Realtime channel opened first, sends `{type:'ready'}`
- [ ] `setUpdateListener` called with serial `0`
- [ ] Ping in `.then()` after replay
- [ ] 30-second `setInterval` ping registered **outside** any try/catch
- [ ] Handles `ping`, `up_to_date`, `meta` payload types
- [ ] No external resources (CSP)
- [ ] `/command` added to `/help` output in `deltachat.ts`
- [ ] Named session registered with `setActiveWebxdcSession`
- [ ] Proactive `meta` push in `sendXxxApp()` so footer shows on first open
