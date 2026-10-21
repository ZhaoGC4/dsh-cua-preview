# Troubleshooting

Start from the two logs:

```bash
tail -f ~/.dsh/cua-preview/plugin.log   # Host plugin
tail -f ~/.dsh/cua-preview/app.log      # Electron overlay
```

A healthy sequence looks like this:

```
plugin.log   server listening on 127.0.0.1:xxxxx
plugin.log   overlay spawned pid=12345 port=xxxxx
plugin.log   overlay connected
app.log      overlay ready
app.log      target windowId=20509 app=文本编辑
app.log      fps=4 target=20509 app=文本编辑
```

## The preview never appears

| Check | Fix |
|---|---|
| `plugin.log` contains `no Electron binary found` | Install Electron, install dsh-orb (its cached Electron is reused), or set `electronPath` in `cordis.patch.yml` |
| `plugin.log` has only `server listening` and nothing else | The Electron process failed to start. Run the overlay manually to see stderr:<br>`"$HOME/.dsh/dsh-orb/electron-runtime/Electron.app/Contents/MacOS/Electron" --no-sandbox /path/to/dsh-cua-preview/app` |
| No `plugin.log` at all | The plugin row is not loaded. Check `cordis.patch.yml` for the `cua-preview` block and restart DSH; verify `ls ~/.dsh/profiles/desktop/node_modules/dsh-cua-preview` |
| Plugin loaded but no `target` lines | The Agent is not using `computer_*` tools (or the tool result had no `window.id`). This project intentionally ignores legacy dsh-orb foreground tools to avoid global previews. |
| `target` lines exist but no `fps` | Screen capture failed. See “Black or empty preview” below. |

## Black or empty preview

- The overlay calls `/usr/sbin/screencapture`. It relies on the DSH Host's
  Screen Recording permission. Verify that System Settings → Privacy & Security →
  **Screen Recording** lists **DeepSeek Harness** and that it is enabled for the
  DSH process that is currently running.
- If you launched the overlay manually from a shell outside the DSH process tree,
  it may not inherit the permission; install/run it through the plugin instead.
- `app.log` shows `capture miss …: could not create image from window` when the
  target window was closed, minimised, or moved to another Space. The overlay
  hides after 8 consecutive misses; the next Computer Use action will show it
  again.

## The preview shows the wrong app / the whole desktop

- This project never renders `window=0` / full-screen captures. If you see a
  global picture, you are probably running the *old* overlay files from an
  earlier revision. Reinstall from this repository and restart DSH, or check
  that `~/.dsh/profiles/desktop/node_modules/dsh-cua-preview` points at the new
  version (`readlink` / `pnpm list dsh-cua-preview` in the profile).
- If it shows another app: the Agent may be observing that app in the same
  session. Look at the session log for the last `computer_observe` result; the
  preview follows the latest observation by design.

## Installing/restarting interrupts my session

The plugin row lives in the `desktop` profile composition. Changing the profile
may force the DSH Host to restart; the session log is persisted and the app
continues automatically, but the in-flight turn is aborted (DSH reports “本轮
已中止”). Save your work before installing or updating.

## macOS says “『Electron』正在后台运行”

That is a macOS system notification about the accessory overlay process (no Dock
icon), not a window from this project. It can appear on the first launch. Silence
it in System Settings → Notifications if desired.

## Drag does not work

- The whole card is a drag region; if another Electron/remote-desktop tool grabs
  the mouse first, try again.
- Three-finger drag must be enabled in System Settings → Accessibility →
  Pointer Control → Trackpad Options → **Use trackpad for dragging** → **Three
  Finger Drag**. With the setting off, mouse dragging still works.
- If the window is clamped to the screen edge, drag it inward; the saved position
  is clamped into the visible work area on restore.

## The preview did not come back after updating the repository

`file:` dependencies point at the repository folder. After `git pull`, the
installed copy under the profile's `node_modules` may not be refreshed. Re-run:

```bash
bash scripts/install.sh
```

or, inside `~/.dsh/profiles/desktop`:

```bash
ELECTRON_RUN_AS_NODE=1 \
DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" --expose-internals \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs" \
  install
```

## Collecting a bug report

Please include:

1. macOS version (`sw_vers`), DeepSeek Harness version (app Info.plist), and
   `@anionex/dsh-computer-use` version;
2. the last ~80 lines of both logs;
3. whether the Agent was using `computer_*` tools (a short excerpt from the
   session log is enough);
4. the output of:

```bash
pgrep -lf 'dsh-cua-preview/app'
```

Do **not** attach screenshots of your desktop or any session content; the logs
do not contain window contents.
