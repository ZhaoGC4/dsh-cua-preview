# Configuration

All configuration lives in the loader row that `install.sh` writes into
`~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
# --- dsh-cua-preview plugin (begin) ---
- insert:
    - id: cua-preview
      name: 'dsh-cua-preview'
      config:
        electronPath: '/Users/you/.dsh/dsh-orb/electron-runtime/Electron.app/Contents/MacOS/Electron'
        captureGapMs: 140
        activeMs: 12000
# --- dsh-cua-preview plugin (end) ---
```

After editing, restart DeepSeek Harness (or let HMR recompose; a Host restart may
occur because the profile composition changed — save your work first).

## Plugin options

| Option | Type | Default | Description |
|---|---|---|---|
| `electronPath` | string | auto-detect | Absolute path to an official Electron binary. Auto-detect order: this option → `$DSH_CUA_PREVIEW_ELECTRON` → `~/.dsh/dsh-orb/electron-runtime/Electron.app/Contents/MacOS/Electron` → `/Applications/Electron.app/Contents/MacOS/Electron`. |
| `appDir` | string | `<package>/app` | Overlay directory. Only change this for development; the npm/file install ships `app/` inside the package. |
| `captureGapMs` | number | `140` | Delay between two frames, in ms. 80 ≈ faster/more CPU, 250 ≈ ~4 fps and lighter. |
| `activeMs` | number | `12000` | How long the preview stays visible after the last Computer Use event. |
| `hideDelayMs` | number | `250` | Extra delay before hiding after a `hide` message (fade margin). |

The plugin validates nothing beyond defaults; invalid values fall back via
`Number(...) || default` semantics in `app/main.js`.

## Environment variables

Set automatically by the plugin when spawning the overlay (useful for manual
debugging):

| Variable | Meaning |
|---|---|
| `DSH_PREVIEW_PORT` | loopback port of the plugin server |
| `DSH_PREVIEW_TOKEN` | 32-byte random handshake token |
| `DSH_PREVIEW_PARENT` | plugin PID; the overlay exits when it disappears |
| `DSH_PREVIEW_CAPTURE_GAP_MS` | forwarded `captureGapMs` |
| `DSH_PREVIEW_ACTIVE_MS` | forwarded `activeMs` |
| `DSH_PREVIEW_HIDE_DELAY_MS` | forwarded `hideDelayMs` |

`DSH_CUA_PREVIEW_ELECTRON` may be set before running `install.sh` to choose a
different Electron binary.

## Runtime files

| Path | Content |
|---|---|
| `~/.dsh/cua-preview/plugin.log` | plugin lifecycle: server, spawn, connect, errors (rotated at 256 KB) |
| `~/.dsh/cua-preview/app.log` | overlay lifecycle: `target`, fps, capture misses (rotated at 256 KB) |
| `~/.dsh/cua-preview/window-state.json` | `{ "x": 800, "y": 271 }` — overlay position |
| `/tmp/dsh-preview-frames/frame-<pid>.jpg` | transient frame; deleted immediately after each read |

## Recipes

### Smoother preview

```yaml
captureGapMs: 90
```

This pushes the overlay towards 7–10 fps on most Apple Silicon Macs at the cost
of more `screencapture` processes. Not recommended below 80ms.

### Lighter CPU / longer battery

```yaml
captureGapMs: 250
activeMs: 8000
```

### Keep the preview visible longer

```yaml
activeMs: 30000
```

### Use a standalone Electron

```yaml
electronPath: '/Applications/Electron.app/Contents/MacOS/Electron'
```

### Reset the position

```bash
rm ~/.dsh/cua-preview/window-state.json
```

The overlay reopens at the bottom-right corner the next time it appears.
