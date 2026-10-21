'use strict'

/**
 * Preload bridge: the renderer has no Node.js access. It only receives two
 * read-only event streams from the main process:
 *   - `preview:frame`  JPEG frame + caption metadata
 *   - `preview:status` caption/app update without a new frame
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('preview', {
  onFrame: (callback) => ipcRenderer.on('preview:frame', (_event, message) => callback(message)),
  onStatus: (callback) => ipcRenderer.on('preview:status', (_event, message) => callback(message))
})
