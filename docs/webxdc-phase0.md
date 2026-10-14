# WebXDC phase 0 — what DeltaChat actually does (2026-10-14)

Before porting v1's WebXDC apps (the `/app` chat surface and the `/todo`
list), we tested the assumptions v1's design rests on, on Alan's Android phone
against the bot's own account (DeltaChat core 2.62.0 via
`@deltachat/stdio-rpc-server`). Harness: [scripts/webxdc-probe/](../scripts/webxdc-probe/).

## Results

| Check                                                                                         | Result                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot pushes `send_webxdc_status_update` into an app instance that has **never sent an update** | Arrives live in ~1 s; core SMTP-sends it within 0.5 s of the call                                                                                                                            |
| Updates pushed while the app is closed (DeltaChat in the background, or force-stopped)        | All replayed by `setUpdateListener(cb, 0)` on next open                                                                                                                                      |
| App → bot (`sendUpdate` from the phone)                                                       | Raises `WebxdcStatusUpdate` on the bot (~13 s, phone-dependent)                                                                                                                              |
| Bot's own pushes                                                                              | Also raise `WebxdcStatusUpdate` on the bot: the echo v1 saw — inbound handling must skip the bot's own payloads                                                                              |
| App **saved to the home screen** and launched from the icon                                   | Starts normally (the `window.webxdc` poll succeeded), replays updates pushed while closed, and receives a live push in ~2 s                                                                  |
| `notify: {"*": "…"}` on a pushed update                                                       | Raises a phone notification with DeltaChat closed normally — **only if the chat is not muted**; nothing arrives while DeltaChat is force-stopped (Android stops delivery until it is opened) |

## What this changes

- **v1's premise is false for current DeltaChat:** a pushed status update is
  sent at once; it does not wait for the app to ping. (The Hermes
  investigation suspected this — `~/.hermes/TODO-deltachat.md` §3.2 #10 — as an
  artefact of testing without `start_io`.) The bot can push directly and rely
  on replay; the ping-triggered drain is not what makes delivery work.
- **Kept anyway, per Alan:** the startup handling v1 learned the hard way
  (polling for `window.webxdc`, an early ready signal, catch-up on start) —
  it is cheap, and the home-screen case passed with the probe's
  `window.webxdc` poll in place (it had no ready signal, so a home-screen
  launch delivering updates _without_ any ping is shown; launch without the
  poll is not). Don't strip lore whose case is untested.
- Not tested here: realtime channels (`WebxdcRealtimeAdvertisementReceived`
  never fired in OpenClaw/v1 either), multiple devices of one user, iOS and
  Desktop clients, very large updates. DeltaChat's documented limits (via
  Simon-Laux/hermes-deltachat-platform's skill reference): `sendUpdateInterval`
  1000 ms (burst of 3), `sendUpdateMaxSize` ~22 MB, pending updates packed into
  ≤ ~100 KiB messages, serials have gaps and differ per device.
