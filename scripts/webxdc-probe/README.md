# WebXDC probe

A phone-in-the-loop check of how DeltaChat delivers WebXDC status updates
between the bot and an app. Used for WebXDC phase 0 (results:
[docs/webxdc-phase0.md](../../docs/webxdc-phase0.md)); rerun it when a
DeltaChat upgrade or a new client might change the answers.

`index.html` + `manifest.toml` are a listener-only app: it shows every update
with its serial and age, and sends nothing unless the "Send ping" button is
tapped. `probe.mjs` drives the bot's own account.

Only one process may hold the bot's account, so the host must be stopped:

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.v2.plist
mkdir -p data/webxdc-probe
(cd scripts/webxdc-probe && zip -q -j ../../data/webxdc-probe/probe.xdc index.html manifest.toml)
cp scripts/webxdc-probe/probe.mjs data/webxdc-probe/   # so the import resolves from the repo
node data/webxdc-probe/probe.mjs &                     # PROBE_CHAT_ID=<chat id> for another chat
echo send >> data/webxdc-probe/cmd                     # send the app; then, as wanted:
echo "update hello" >> data/webxdc-probe/cmd           # push a status update
echo "text hello" >> data/webxdc-probe/cmd             # send a plain text
echo read >> data/webxdc-probe/cmd                     # log all updates the bot sees
echo quit >> data/webxdc-probe/cmd
launchctl load ~/Library/LaunchAgents/com.nanoclaw.v2.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.v2
```

Everything is logged to `data/webxdc-probe/probe.log`. A replayed update's
"age" is the time since it was sent, not its delivery time; read delivery
times from updates that arrive while the app is open.
