/**
 * dsh-cua-preview — DSH Host plugin.
 *
 * The plugin runs inside the DeepSeek Harness Host process. It observes the
 * Session event stream, extracts the exact window that the background Computer
 * Use tools are observing (`computer_*` tool results contain an observation JSON
 * with `app` + `window.id`), and forwards that target to a small Electron overlay.
 *
 * The overlay itself captures the pixels of that one window. This split exists
 * because screen recording permission belongs to the Host (it already has it),
 * while the overlay is a separate GUI process that must never take focus.
 *
 * Wire protocol (newline-delimited JSON over 127.0.0.1, token handshake):
 *   overlay -> plugin  { "type": "hello", "token": "<random>" }
 *   plugin  -> overlay { "type": "activity", "status": "observe" }
 *   plugin  -> overlay { "type": "target", "windowId": 42, "app": "文本编辑",
 *                        "title": "fixture.txt", "status": "observe" }
 *   plugin  -> overlay { "type": "status", "app": "...", "title": "...", "text": "..." }
 *   plugin  -> overlay { "type": "hide" }
 *
 * The plugin never captures the screen itself and never sends global input.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'cua-preview'

/** Repository root — the folder that contains `plugin/` and `app/`. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** Bundled overlay application directory. */
const DEFAULT_APP_DIR = path.join(PACKAGE_ROOT, 'app')
/** Log location under the user's home; resolved lazily so tests can override HOME. */
const LOG_LIMIT_BYTES = 256 * 1024

/** Tool names that carry a macOS GUI observation. */
const COMPUTER_TOOL_PREFIX = 'computer_'
/** Legacy dsh-orb foreground tools are intentionally NOT previewed: they use the
 *  global screen and would produce a "global preview", which this feature avoids. */
const LEGACY_TOOLS = new Set(['click', 'input_text', 'scroll', 'hotkey', 'long_press', 'drag', 'open_app'])

/** Default configuration; every field can be overridden in the profile patch. */
const DEFAULT_CONFIG = {
  /** Absolute path to an official Electron binary. Empty = auto-detect. */
  electronPath: '',
  /** Overlay app directory. */
  appDir: DEFAULT_APP_DIR,
  /** Delay between two window captures, in milliseconds (~7 fps at 140). */
  captureGapMs: 140,
  /** How long the preview stays visible after the last Computer Use event. */
  activeMs: 12_000,
  /** Extra time the overlay keeps the last frame after `hide` (fade-out margin). */
  hideDelayMs: 250
}

/**
 * Resolve an Electron binary without downloading anything.
 * Users of dsh-orb already have a pinned official Electron cache; otherwise
 * `electronPath` must be configured or Electron installed in /Applications.
 */
function resolveElectronPath (configured) {
  const candidates = [
    configured,
    process.env.DSH_CUA_PREVIEW_ELECTRON,
    path.join(os.homedir(), '.dsh', 'dsh-orb', 'electron-runtime', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    '/Applications/Electron.app/Contents/MacOS/Electron'
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return ''
}

/** Open the plugin log, creating its directory and rotating it when it grows. */
function openLog () {
  const homeDir = path.join(os.homedir(), '.dsh', 'cua-preview')
  const logFile = path.join(homeDir, 'plugin.log')
  try { mkdirSync(homeDir, { recursive: true }) } catch {}
  try {
    if (statSync(logFile).size > LOG_LIMIT_BYTES) writeFileSync(logFile, '')
  } catch {}
  const stream = createWriteStream(logFile, { flags: 'a' })
  return {
    write (line) {
      try { stream.write(`${new Date().toISOString()} ${line}\n`) } catch {}
    },
    close () {
      try { stream.end() } catch {}
    }
  }
}

/**
 * Extract `{ windowId, app, bundleId, title }` from an Anionex Computer Use tool
 * result. The tool content contains a JSON string with `app` and `window`; any
 * other text parts (warnings, human-readable notes) are ignored.
 *
 * @param {unknown} content - `message.content` array of a tool result event.
 * @returns {{windowId:number, app:string, bundleId:string, title:string}|undefined}
 */
function extractObservationTarget (content) {
  if (!Array.isArray(content)) return undefined
  for (const part of content) {
    if (!part || part.type !== 'text' || typeof part.text !== 'string') continue
    const trimmed = part.text.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const observation = JSON.parse(trimmed)
      const windowId = Number(observation?.window?.id) || 0
      if (windowId <= 0 || !observation?.app) continue
      return {
        windowId,
        app: observation.app.name || observation.app.bundleId || '',
        bundleId: observation.app.bundleId || '',
        title: observation.window.title || ''
      }
    } catch {
      // Not the observation JSON — keep scanning the remaining text parts.
    }
  }
  return undefined
}

/** Human-readable status label for a tool name (shown in the overlay caption). */
function toolStatus (toolName) {
  return String(toolName || '').replace(COMPUTER_TOOL_PREFIX, '')
}

/**
 * Cordis plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - DSH plugin context.
 * @param {Partial<typeof DEFAULT_CONFIG>} [config] - profile patch config.
 */
export function apply (ctx, config = {}) {
  const options = { ...DEFAULT_CONFIG, ...(config || {}) }
  const log = openLog()
  const electronPath = resolveElectronPath(options.electronPath)

  /** Runtime state of one plugin instance. */
  const state = {
    server: undefined,
    socket: undefined,
    socketAuthorized: false,
    child: undefined,
    token: randomBytes(32).toString('hex'),
    activeUntil: 0,
    hidden: true,
    pendingCalls: new Map(),
    retries: 0,
    timers: []
  }

  if (!electronPath) {
    log.write('no Electron binary found; set electronPath in the profile patch or install dsh-orb/Electron')
    return () => log.close()
  }

  /** @param {object} message - protocol message, see the header comment. */
  function send (message) {
    if (!state.socketAuthorized || !state.socket) return
    try { state.socket.write(`${JSON.stringify(message)}\n`) } catch {}
  }

  /** Wake the overlay: it shows itself once a concrete target arrives. */
  function noteActivity (status) {
    state.activeUntil = Date.now() + options.activeMs
    state.hidden = false
    send({ type: 'activity', status: status || '' })
  }

  /** Tell the overlay exactly which window to preview. */
  function noteTarget (target, status) {
    state.activeUntil = Date.now() + options.activeMs
    state.hidden = false
    send({
      type: 'target',
      windowId: target.windowId,
      app: target.app,
      title: target.title,
      status: status || ''
    })
  }

  /** Forward a caption update without changing the current target. */
  function noteStatus (status) {
    send({ type: 'status', app: '', title: '', text: status || '' })
  }

  /** Port the overlay should connect to; 0 when the server is not listening yet. */
  function serverPort () {
    const address = state.server?.address()
    return typeof address === 'object' && address ? address.port : 0
  }

  /** Spawn (or retry) the Electron overlay process. */
  function launchOverlay () {
    if (state.child) return
    const env = { ...process.env }
    // The Host itself runs with ELECTRON_RUN_AS_NODE=1; the overlay must run as a
    // normal GUI app, so both Electron-node markers are removed.
    delete env.ELECTRON_RUN_AS_NODE
    delete env.DSH_DESKTOP_NODE_EXECUTABLE
    env.DSH_PREVIEW_PORT = String(serverPort())
    env.DSH_PREVIEW_TOKEN = state.token
    env.DSH_PREVIEW_PARENT = String(process.pid)
    env.DSH_PREVIEW_CAPTURE_GAP_MS = String(options.captureGapMs)
    env.DSH_PREVIEW_ACTIVE_MS = String(options.activeMs)
    env.DSH_PREVIEW_HIDE_DELAY_MS = String(options.hideDelayMs)

    const child = spawn(electronPath, ['--no-sandbox', options.appDir], {
      env,
      stdio: ['ignore', 'ignore', 'pipe']
    })
    state.child = child
    log.write(`overlay spawned pid=${child.pid ?? 'unknown'} port=${serverPort()}`)

    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })

    child.once('error', (error) => log.write(`overlay spawn error: ${String(error)}`))
    child.once('exit', (code, signal) => {
      log.write(`overlay exited code=${code ?? 'null'} signal=${signal ?? 'null'}${stderr ? ` stderr=${stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}` : ''}`)
      if (state.child === child) state.child = undefined
      state.socket = undefined
      state.socketAuthorized = false
      // Bounded restart: a repeatedly crashing overlay must not loop forever.
      if (state.retries < 3) {
        state.retries += 1
        state.timers.push(setTimeout(launchOverlay, 1200))
      }
    })
  }

  /** Loopback server for the overlay's status/frame protocol. */
  function startServer () {
    const server = net.createServer((socket) => {
      state.socket = socket
      state.socketAuthorized = false
      socket.setEncoding('utf8')
      let buffer = ''
      socket.on('data', (chunk) => {
        if (state.socketAuthorized) return // overlay only talks during the handshake
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (!line.trim()) continue
          try {
            const hello = JSON.parse(line)
            if (hello?.type !== 'hello' || hello.token !== state.token) {
              socket.destroy()
              return
            }
            state.socketAuthorized = true
            state.retries = 0
            log.write('overlay connected')
            if (Date.now() < state.activeUntil) noteActivity('')
          } catch {
            socket.destroy()
            return
          }
        }
      })
      socket.on('error', () => {})
      socket.on('close', () => {
        if (state.socket === socket) {
          state.socket = undefined
          state.socketAuthorized = false
          log.write('overlay disconnected')
        }
      })
    })
    server.on('error', (error) => log.write(`server error: ${String(error)}`))
    server.listen(0, '127.0.0.1', () => {
      log.write(`server listening on 127.0.0.1:${serverPort()}`)
      launchOverlay()
    })
    state.server = server
  }

  /** Session event listener: turn tool calls/results into preview targets. */
  function onSessionEvent (_session, event) {
    try {
      if (event?.type === 'tool/call') {
        const tool = event.data?.name
        if (typeof tool !== 'string' || !tool.startsWith(COMPUTER_TOOL_PREFIX)) return
        state.pendingCalls.set(event.data.callId, tool)
        noteActivity(toolStatus(tool))
        return
      }
      if (event?.type === 'tool/result') {
        const message = event.data?.message
        if (!message || message.role !== 'tool') return
        const tool = state.pendingCalls.get(message.toolCallId)
        if (!tool) return
        state.pendingCalls.delete(message.toolCallId)
        const target = extractObservationTarget(message.content)
        if (target) noteTarget(target, toolStatus(tool))
        else noteActivity(toolStatus(tool))
      }
    } catch (error) {
      log.write(`session event error: ${String(error)}`)
    }
  }

  ctx.on('session/event', onSessionEvent)

  ctx.effect(() => {
    const idleTimer = setInterval(() => {
      // Hide the overlay one full `activeMs` after the last Computer Use event.
      if (!state.hidden && Date.now() > state.activeUntil) {
        state.hidden = true
        send({ type: 'hide' })
      }
    }, 1000)
    state.timers.push(idleTimer)
    startServer()
    return () => {
      log.write('plugin disposing')
      for (const timer of state.timers) clearInterval(timer)
      try { state.child?.kill('SIGTERM') } catch {}
      try { state.server?.close() } catch {}
      try { state.socket?.destroy() } catch {}
      log.close()
    }
  }, 'dsh-cua-preview lifecycle')
}
