'use strict'

/**
 * Renderer for the preview overlay.
 *
 * It intentionally has no business logic: the main process decides when a frame
 * is available and what the caption says. The renderer only:
 *   1. cross-fades between the two image layers (no flicker at 3–7 fps);
 *   2. keeps the caption (app · window · action) for a short while;
 *   3. reveals the card on the first frame.
 */

const card = document.getElementById('card')
const view = document.getElementById('view')
const caption = document.getElementById('caption')
const appLabel = document.getElementById('app')
const layers = [document.getElementById('frameA'), document.getElementById('frameB')]

/** Which layer currently holds the visible frame. */
let front = 0
let status = { app: '', title: '', text: '' }
let captionTimer = null

/** Update the header app label and the transient bottom caption. */
function renderStatus (next) {
  status = { app: next.app || '', title: next.title || '', text: next.text || '' }
  appLabel.textContent = status.app || ''
  const parts = [status.app, status.title, status.text].filter(Boolean)
  if (parts.length) {
    caption.textContent = parts.join('  ·  ')
    caption.classList.add('show')
    clearTimeout(captionTimer)
    captionTimer = setTimeout(() => caption.classList.remove('show'), 2600)
  }
}

window.preview.onStatus(renderStatus)

window.preview.onFrame((message) => {
  if (!message || !message.jpeg) return
  // Load into the hidden layer, then swap classes once the image decoded so the
  // old frame never disappears before the new one is ready.
  const next = layers[front ^ 1]
  const current = layers[front]
  next.onload = () => {
    next.classList.add('front')
    current.classList.remove('front')
    front ^= 1
    card.classList.add('visible')
    view.classList.add('has-frame')
  }
  const mime = message.mime || 'image/jpeg'
  next.src = `data:${mime};base64,${message.jpeg}`
  if (message.app || message.title || message.status) {
    renderStatus({ app: message.app, title: message.title, text: message.status })
  }
})
