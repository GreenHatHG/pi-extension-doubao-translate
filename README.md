# pi-extension-doubao-translate

pi package: auto-translate assistant replies to Chinese via the doubao server.

- Only the final prose reply is translated (last text block of a tool-call-free assistant message).
- `/zh` toggles display: off = original only, on = original + Chinese below. State persists in `~/.pi/agent/cache/doubao-translate-state.json`.
- Fenced code blocks are excluded from translation.
- Transport: unix-socket tunnel in `/tmp` (VPS) or direct TCP `127.0.0.1:8765` (Mac).

## Install

Add to `packages` in `~/.pi/agent/settings.json`:

```json
"../projects/pi-extension-doubao-translate"
```
