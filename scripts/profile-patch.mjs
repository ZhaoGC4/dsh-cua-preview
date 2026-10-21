#!/usr/bin/env node
/**
 * profile-patch.mjs — tiny helper that owns the `cordis.patch.yml` edit for
 * install.sh / uninstall.sh.
 *
 * It is run with the DSH-bundled Electron in Node mode, so the installer does
 * not depend on a globally installed Node.js or a YAML library:
 *
 *   ELECTRON_RUN_AS_NODE=1 "<DeepSeek Harness>" scripts/profile-patch.mjs \
 *       install "<profile-dir>" "<electron-path-or-empty>"
 *
 * The row is enclosed in BEGIN/END comment markers so the uninstaller can remove
 * exactly what it added without touching any other user configuration.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

const BEGIN = '# --- dsh-cua-preview plugin (begin) ---'
const END = '# --- dsh-cua-preview plugin (end) ---'

/** Quote a filesystem path as a single-quoted YAML scalar. */
function yamlQuote (value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Build the YAML block that inserts the preview plugin row. */
function buildBlock (electronPath) {
  const lines = [
    BEGIN,
    '- insert:',
    '    - id: cua-preview',
    "      name: 'dsh-cua-preview'",
    '      config:'
  ]
  if (electronPath) lines.push(`        electronPath: ${yamlQuote(electronPath)}`)
  lines.push(
    '        captureGapMs: 140',
    '        activeMs: 12000',
    END
  )
  return lines.join('\n')
}

/** Remove a previously installed BEGIN..END block (if any). */
function removeBlock (text) {
  const start = text.indexOf(BEGIN)
  if (start === -1) return { text, changed: false }
  const end = text.indexOf(END, start)
  if (end === -1) {
    // Corrupt marker pair: remove from BEGIN to the end of the file.
    return { text: `${text.slice(0, start).trimEnd()}\n`, changed: true }
  }
  const after = text.slice(end + END.length)
  const before = text.slice(0, start)
  return { text: `${before.trimEnd()}\n${after.replace(/^\s*\n/, '')}`, changed: true }
}

async function main () {
  const [mode, profileDir, electronPath = ''] = process.argv.slice(2)
  if ((mode !== 'install' && mode !== 'uninstall') || !profileDir) {
    console.error('usage: profile-patch.mjs <install|uninstall> <profile-dir> [electron-path]')
    process.exit(2)
  }
  const file = path.join(profileDir, 'cordis.patch.yml')
  let text = ''
  try { text = await readFile(file, 'utf8') } catch {}

  const stripped = removeBlock(text).text
  const next = mode === 'install'
    ? `${stripped.trimEnd()}\n\n${buildBlock(electronPath)}\n`
    : `${stripped.trimEnd()}\n`

  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, next)
  await rename(temporary, file)
  console.log(`${mode}: ${file}`)
}

main().catch((error) => {
  console.error(String(error))
  process.exit(1)
})
