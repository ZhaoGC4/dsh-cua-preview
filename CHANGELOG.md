# Changelog

## 1.0.0 — 2026-10-21

Initial public release.

- DSH Host plugin (`plugin/index.js`): observes `computer_*` tool results,
  extracts the exact `app`/`window.id` observation, forwards it to the overlay.
- Electron overlay (`app/`):
  - macOS `vibrancy: 'hud'` glass card, minimal one-line UI;
  - window-only capture via `screencapture -l<windowId>` (never global screen);
  - ~3–7 fps double-buffered cross-fade rendering;
  - non-activating, always-on-top panel that never takes focus or keyboard input;
  - movable via mouse or macOS three-finger drag, position persisted;
  - automatic show on Computer Use activity, hide after `activeMs` idle.
- `scripts/install.sh` / `scripts/uninstall.sh`: safe desktop-profile
  registration with automatic backups and marker-based patching.
- Documentation: architecture, configuration, troubleshooting.
