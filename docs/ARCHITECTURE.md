# Architecture

## Design goals

1. **Never show global screen content.** The preview must be bound to exactly the
   window referenced by the current Computer Use observation.
2. **Never steal focus or input.** The overlay is display-only; it must not
   change the foreground app, the keyboard focus, or the real mouse position.
3. **No extra permissions.** Screen capture must reuse the DeepSeek Harness
   Host's existing Screen Recording grant.
4. **Cheap and safe by default.** No network, no telemetry, no persistent frames,
   no input injection, bounded logs and retries.
5. **Readable and easy to audit.** Two small processes, a newline-delimited JSON
   protocol, and no runtime npm dependencies.

## Components

```
┌──────────────────────────────────────────────────────────────────────┐
│ DeepSeek Harness Desktop Host (already has Screen Recording)          │
│                                                                      │
│  Session event stream                                                │
│    tool/call   { name: "computer_observe", callId, arguments }       │
│    tool/result { toolCallId, message.content: [ ... observation JSON ] } │
│            │                                                         │
│            ▼                                                         │
│  plugin/index.js  (Cordis plugin, runs inside Host)                  │
│    - pendingCalls: callId -> tool name                               │
│    - parses observation JSON: app, window.id, window.title           │
│    - serves a 127.0.0.1 TCP socket (random port, 32-byte token)      │
│    - spawns the overlay once, restarts it at most 3 times            │
└───────────────┬──────────────────────────────────────────────────────┘
                │ target/activity/status/hide (NDJSON, loopback)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ Electron overlay (app/main.js)                                       │
│   frameless, transparent, vibrancy: "hud", always-on-top panel        │
│   focusable: false, showInactive(), movable, draggable card          │
│                                                                      │
│   for each target:                                                   │
│     screencapture -x -t jpg -l<windowId> /tmp/...jpg                 │
│       -> read bytes -> delete file -> send data:image/jpeg to renderer│
│   capture gap ~140ms (≈3–7 fps), double-buffered cross-fade           │
└──────────────────────────────────────────────────────────────────────┘
```

## Why the split?

- **Screen Recording permission follows the process responsible for the capture.**
  The Host already has it (Computer Use needs it). A newly installed standalone
  GUI app does not, and macOS would silently produce black frames. The overlay is
  spawned by the Host plugin, so the `screencapture` child inherits the Host's
  grant chain; no new TCC prompt is involved.
- **The overlay must not live inside the Host process.** The DSH Host runs as a
  Node process (`ELECTRON_RUN_AS_NODE=1`) and cannot create windows. A separate
  Electron process is the minimal way to draw an always-on-top panel.
- **The plugin must not capture.** Keeping all pixel work in the overlay makes
  the Host plugin trivial (event parsing + forwarding) and prevents any
  accidental full-screen capture from the Host side.

## Protocol (newline-delimited JSON over loopback)

| Direction | Message | Meaning |
|---|---|---|
| overlay → plugin | `{"type":"hello","token":"<32-byte hex>"}` | handshake; any other first message closes the socket |
| plugin → overlay | `{"type":"activity","status":"observe"}` | a `computer_*` call happened; wake the preview |
| plugin → overlay | `{"type":"target","windowId":42,"app":"文本编辑","title":"a.txt","status":"observe"}` | the exact window to preview; starts capture |
| plugin → overlay | `{"type":"status","app":"…","title":"…","text":"click"}` | caption update without a new frame |
| plugin → overlay | `{"type":"hide"}` | idle timeout reached; hide after a short fade |

`windowId` is the macOS WindowServer window number from
`observation.window.id` (the same value accepted by `screencapture -l`). The
overlay refuses to capture without a positive `windowId`, which is what makes
"no global preview" a structural guarantee rather than a UI preference.

## Event parsing

The Anionex Computer Use tools return an observation as one of the text parts of
the tool result. Example (truncated):

```json
{
  "observationId": "…",
  "app": { "bundleId": "com.apple.TextEdit", "name": "文本编辑", "pid": 123 },
  "frontmost": false,
  "window": { "id": 20509, "title": "fixture.txt", "frame": { … } }
}
```

`extractObservationTarget()` tries each text part that starts with `{`, parses it,
and accepts only entries with `window.id > 0`. This also keeps warning text,
screenshots metadata, and unrelated JSON out of the preview path.

## Capture and rendering

- One `screencapture` process per frame (~100–150ms on an Apple Silicon Mac),
  started only while a target is active; the next capture is scheduled after the
  previous one settles (single-flight). This yields roughly 3–7 fps depending on
  machine load.
- The JPEG is read, the temp file is unlinked, and the bytes are passed to the
  renderer as a `data:` URL.
- The renderer keeps two `<img>` layers. A new frame is loaded into the hidden
  layer and only becomes visible (`opacity` transition) after `onload`, so the
  old frame is never removed before the new one is ready.
- The window is shown with `showInactive()` on the first frame — not before — so
  no empty/placeholder window flashes.

## Window behavior

| Setting | Value | Reason |
|---|---|---|
| `focusable` | `false` | cannot take keyboard focus |
| `type` | `panel` | NSPanel; floats above normal windows |
| `alwaysOnTop` level | `screen-saver` | stays visible over fullscreen apps |
| `movable` | `true` | mouse and three-finger drag work |
| `-webkit-app-region` | `drag` on the card | the whole card is a drag handle |
| `showInactive()` | on first frame | show without activation |
| position | `~/.dsh/cua-preview/window-state.json` | restored on next show; clamped into the visible area |

## Failure handling

- Overlay crash: the plugin restarts it up to 3 times with a 1.2s delay.
- Capture misses (window closed/minimised): after 8 consecutive misses the
  preview hides and the target is cleared; a stale picture is never shown.
- Idle: the plugin sends `hide` after `activeMs` (12s default); the overlay also
  has its own idle timer as a safety net.
- Plugin unload/HMR dispose: the overlay child is killed and the socket closed.
- Host exit: the overlay checks its parent PID every second and quits.

## Security boundaries

- The loopback socket is not a security boundary against other processes running
  as the same user, but the token handshake prevents accidental/misguided
  clients, and the protocol carries no credentials or user data beyond the
  window id/app name.
- The overlay never reads session files, clipboard, or network.
- The only persisted state is the window position and two bounded log files.

## Possible future work

- Attach `sessionId` to `target` messages for strict per-session binding when
  several Agents operate different apps concurrently.
- Optional "stop agent" button if DSH exposes a supported session-abort API.
- ScreenCaptureKit streaming instead of `screencapture` for 15–30 fps.
