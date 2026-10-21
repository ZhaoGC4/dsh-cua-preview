'use strict'

/**
 * dsh-cua-preview — overlay application.
 *
 * This is a small, always-on-top Electron panel that shows the *single window*
 * the Agent is currently operating. It is deliberately:
 *
 * - non-activating (`focusable: false`, `showInactive()`), so the foreground app
 *   and the user's keyboard focus are never stolen;
 * - draggable (mouse drag or macOS three-finger drag) and remembers its position;
 * - only visible while Computer Use activity is in flight, and hidden after an
 *   idle timeout;
 * - never showing global screen content: the only pixels it displays come from
 *   `screencapture -l<windowId>` for the exact target forwarded by the Host
 *   plugin, so a stale or unrelated window can never leak into the preview.
 *
 * The macOS glass look comes from the native `vibrancy: 'hud'` material plus a
 * light tint; the HTML adds only typography, rounding and the thumbnail layer.
 *
 * Environment variables set by the plugin:
 *   DSH_PREVIEW_PORT             loopback port of the plugin server
 *   DSH_PREVIEW_TOKEN            32-byte handshake token (never written to disk)
 *   DSH_PREVIEW_PARENT           plugin's PID; the overlay quits when it exits
 *   DSH_PREVIEW_CAPTURE_GAP_MS   delay between two captures
 *   DSH_PREVIEW_ACTIVE_MS        idle budget for the preview
 *   DSH_PREVIEW_HIDE_DELAY_MS    extra delay after a `hide` message
 */

const { app, BrowserWindow, screen } = require('electron')
const { execFile } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

/** ----- configuration ----- */
const PORT = Number(process.env.DSH_PREVIEW_PORT || 0)
const TOKEN = String(process.env.DSH_PREVIEW_TOKEN || '')
const PARENT = Number(process.env.DSH_PREVIEW_PARENT || 0)
const CAPTURE_GAP_MS = Math.max(60, Number(process.env.DSH_PREVIEW_CAPTURE_GAP_MS || 140))
const ACTIVE_MS = Math.max(2000, Number(process.env.DSH_PREVIEW_ACTIVE_MS || 12000))
const HIDE_DELAY_MS = Math.max(0, Number(process.env.DSH_PREVIEW_HIDE_DELAY_MS || 250))

/** Window dimensions in points. */
const WIDTH = 340
const HEIGHT = 252
/** Stored position, so a user-dragged window reappears where it was left. */
const STATE_FILE = path.join(os.homedir(), '.dsh', 'cua-preview', 'window-state.json')
/** Human-readable overlay log (fps, target changes); bounded by rotation. */
const LOG_FILE = path.join(os.homedir(), '.dsh', 'cua-preview', 'app.log')
/** Temporary JPEG frames written by `screencapture`; deleted immediately after read. */
const TEMP_DIR = path.join(os.tmpdir(), 'dsh-preview-frames')

/** ----- runtime state ----- */
let win = null
let socket = null
let buffer = ''
let handshaked = false
let hideTimer = null
let activeUntil = 0
let captureTimer = null
let captureBusy = false
let target = null
let status = { app: '', title: '', text: '' }
let consecutiveFailures = 0
let moveSaveTimer = null
let frameCounter = 0
let fpsMark = Date.now()

fs.mkdirSync(TEMP_DIR, { recursive: true })
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }) } catch {}

/** Append one timestamped line to the overlay log, rotating it when it grows. */
try {
  if (fs.statSync(LOG_FILE).size > 256 * 1024) fs.writeFileSync(LOG_FILE, '')
} catch {}
function log (line) {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`) } catch {}
}

/** Load the saved top-left corner, clamped into the current display. */
function loadPosition () {
  const area = screen.getPrimaryDisplay().workArea
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    const x = Math.min(Math.max(Number(saved.x) || 0, area.x - WIDTH + 80), area.x + area.width - 80)
    const y = Math.min(Math.max(Number(saved.y) || 0, area.y - 20), area.y + area.height - 60)
    return { x: Math.round(x), y: Math.round(y) }
  } catch {
    return {
      x: Math.round(area.x + area.width - WIDTH - 20),
      y: Math.round(area.y + area.height - HEIGHT - 20)
    }
  }
}

/** Persist the current top-left corner (debounced by the `moved` listener). */
function savePosition () {
  if (!win) return
  try {
    const bounds = win.getBounds()
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ x: bounds.x, y: bounds.y }))
  } catch {}
}

/** Create the frameless, transparent, vibrancy-backed overlay window. */
function createWindow () {
  const position = loadPosition()
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x: position.x,
    y: position.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: 'hud',
    visualEffectState: 'active',
    roundedCorners: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: true,
    type: 'panel',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(path.join(__dirname, 'index.html'))
  win.on('moved', () => {
    clearTimeout(moveSaveTimer)
    moveSaveTimer = setTimeout(savePosition, 400)
  })
}

/** Forward a message to the renderer (HTML/CSS layer). */
function toRenderer (channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(`preview:${channel}`, payload)
}

/** Show without activating, and schedule the idle hide. */
function showWindow () {
  if (!win) return
  if (!win.isVisible()) win.showInactive()
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (win && win.isVisible()) win.hide()
    stopCapturing()
  }, ACTIVE_MS + HIDE_DELAY_MS)
}

/** Stop the capture loop and mark the preview inactive. */
function stopCapturing () {
  activeUntil = 0
  clearTimeout(captureTimer)
  captureTimer = null
}

/** Update the caption text and app label shown in the overlay. */
function updateStatus (next) {
  status = {
    app: next.app || status.app || (target ? target.app : ''),
    title: next.title || status.title || (target ? target.title : ''),
    text: next.text || ''
  }
  toRenderer('status', status)
}

/** Handle one newline-delimited JSON message from the plugin. */
function handlePluginMessage (message) {
  if (!message || typeof message.type !== 'string') return

  if (message.type === 'activity') {
    activeUntil = Date.now() + ACTIVE_MS
    if (message.status) updateStatus({ text: message.status })
    // No pixels yet: the overlay stays hidden until a concrete target arrives.
    return
  }

  if (message.type === 'target') {
    const windowId = Number(message.windowId) || 0
    if (windowId <= 0) return
    target = { windowId, app: message.app || '', title: message.title || '' }
    log(`target windowId=${windowId} app=${target.app}`)
    activeUntil = Date.now() + ACTIVE_MS
    consecutiveFailures = 0
    updateStatus({ app: target.app, title: target.title, text: message.status || '' })
    ensureCapture()
    return
  }

  if (message.type === 'status') {
    updateStatus({ app: message.app, title: message.title, text: message.text })
    return
  }

  if (message.type === 'hide') {
    stopCapturing()
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (win && win.isVisible()) win.hide()
    }, HIDE_DELAY_MS)
  }
}

/** Connect to the plugin's loopback server and start the token handshake. */
function connect () {
  if (!PORT || !TOKEN) return
  socket = net.connect({ host: '127.0.0.1', port: PORT }, () => {
    socket.write(`${JSON.stringify({ type: 'hello', token: TOKEN })}\n`)
    handshaked = true
  })
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      try { handlePluginMessage(JSON.parse(line)) } catch {}
    }
  })
  socket.on('close', () => {
    socket = null
    handshaked = false
    stopCapturing()
    setTimeout(connect, 1000)
  })
  socket.on('error', () => {})
}

/** Start the capture loop if there is a target and the overlay is active. */
function ensureCapture () {
  if (captureTimer || captureBusy) return
  if (Date.now() > activeUntil || !target) return
  scheduleCapture(20)
}

/** Schedule one capture attempt after `delay` ms (single-flight). */
function scheduleCapture (delay) {
  if (captureTimer) return
  captureTimer = setTimeout(() => {
    captureTimer = null
    runCapture()
  }, delay)
}

/**
 * Capture exactly the target window and send the JPEG to the renderer.
 * `screencapture -l<windowId>` is a window-only capture: other windows (including
 * the overlay itself and the user's desktop) are never included.
 */
function runCapture () {
  if (Date.now() > activeUntil || !target) { stopCapturing(); return }
  if (captureBusy) { scheduleCapture(CAPTURE_GAP_MS); return }

  captureBusy = true
  const file = path.join(TEMP_DIR, `frame-${process.pid}.jpg`)
  const args = ['-x', '-t', 'jpg', `-l${target.windowId}`, file]

  execFile('/usr/sbin/screencapture', args, { timeout: 3000 }, (error) => {
    let bytes = null
    if (!error) {
      try { bytes = fs.readFileSync(file) } catch {}
    }
    try { fs.unlinkSync(file) } catch {}
    captureBusy = false

    if (bytes && bytes.length > 1000) {
      consecutiveFailures = 0
      frameCounter += 1
      const now = Date.now()
      if (now - fpsMark >= 1000) {
        log(`fps=${Math.round((frameCounter * 1000) / (now - fpsMark))} target=${target.windowId} app=${target.app}`)
        frameCounter = 0
        fpsMark = now
      }
      toRenderer('frame', {
        jpeg: bytes.toString('base64'),
        mime: 'image/jpeg',
        app: target.app,
        title: target.title,
        status: status.text
      })
      showWindow()
    } else {
      // The window may have been closed or minimised; hide after a few misses
      // instead of showing a stale picture or a global fallback.
      consecutiveFailures += 1
      if (consecutiveFailures <= 2) log(`capture miss ${consecutiveFailures} (window ${target.windowId})${error ? `: ${String(error).slice(0, 120)}` : ''}`)
      if (consecutiveFailures >= 8) {
        log(`capture failed ${consecutiveFailures}x; hiding (window ${target.windowId})`)
        target = null
        stopCapturing()
        if (win && win.isVisible()) win.hide()
        return
      }
    }
    scheduleCapture(CAPTURE_GAP_MS)
  })
}

/** True while the plugin process that spawned this overlay is alive. */
function parentAlive () {
  if (!PARENT) return true
  try { process.kill(PARENT, 0); return true } catch { return false }
}

app.whenReady().then(() => {
  // Agent-style app: no Dock icon, no app switcher entry.
  try { app.setActivationPolicy('accessory') } catch {}
  createWindow()
  connect()
  log('overlay ready')
  setInterval(() => {
    if (!parentAlive()) app.quit()
    if (activeUntil && Date.now() > activeUntil) stopCapturing()
  }, 1000)
})

app.on('before-quit', savePosition)
app.on('window-all-closed', (event) => { event.preventDefault?.() })
