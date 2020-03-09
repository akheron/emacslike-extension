import { window, QuickPickItem, workspace, QuickPick } from 'vscode'

import * as fsC from 'fs'
const fs = fsC.promises
import { Dirent } from 'fs'
import * as path from 'path'

import { setContext, activeFileDirectory } from './utils'

export const ACTIVE_CONTEXT_VAR = 'emacslike.findfile.active'
export const EMPTY_CONTEXT_VAR = 'emacslike.findfile.empty'

export type FindFileState = QuickPick<DirectoryEntry>

export function init(): FindFileState {
  const picker = window.createQuickPick<DirectoryEntry>()
  picker.onDidChangeValue(value => {
    // User typed to the input field
    setContextFromValue(value)
    maybeChangeTo(picker, value)
  })
  picker.onDidAccept(() => {
    // User pressed enter, i.e. accepted the selected item
    openSelected(picker)
  })
  picker.onDidHide(() => {
    setContext(ACTIVE_CONTEXT_VAR, false)
  })
  return picker
}

export function show(picker: FindFileState) {
  clearValue(picker)
  changeToDirectory(picker, getInitialDirectory())
  showWithCurrentState(picker)
}

export function select(picker: FindFileState) {
  const item = currentItem(picker)
  if (!item) return

  if (item.type === 'directory') {
    clearValue(picker)
    changeToDirectory(picker, item.fullPath)
  } else if (item.type === 'file') {
    openFile(item.fullPath)
    picker.hide()
  }
}

export function openPartial(picker: FindFileState) {
  const filePath = pathFromCurrentValue(picker)
  if (filePath !== undefined) {
    createFileIfNotExists(filePath)
    openFile(filePath)
  }
}

export function createDirectoryPartial(picker: FindFileState) {
  const dirPath = pathFromCurrentValue(picker)
  if (dirPath !== undefined) {
    createDirectoryIfNotExists(dirPath)
    clearValue(picker)
    changeToDirectory(picker, dirPath)
  }
}

export function goToParent(picker: FindFileState) {
  const currentDir = currentDirectory(picker)
  if (currentDir === '/') return
  changeToDirectory(picker, path.dirname(currentDir))
}

export function rename(picker: FindFileState) {
  const item = currentItem(picker)
  if (!item) return

  const { dirName, fileName } = splitPath(item.fullPath)
  window
    .showInputBox({ prompt: `Rename ${fileName}`, value: fileName })
    .then(async newName => {
      if (newName) {
        fs.rename(item.fullPath, path.join(dirName, newName))
      }
      await refreshFileList(picker)
      showWithCurrentState(picker)
    })
}

export function remove(picker: FindFileState) {
  const item = currentItem(picker)
  if (!item) return

  const fileName = path.basename(item.fullPath)
  const message =
    item.type === 'directory'
      ? `Recursively delete ${fileName}?`
      : `Really delete ${fileName}?`

  window
    .showInformationMessage(message, { modal: true }, 'Delete')
    .then(async result => {
      if (result === 'Delete') {
        // User pressed "Delete"
        if (item.type === 'directory') {
          await fs.rmdir(item.fullPath, { recursive: true })
        } else {
          await fs.unlink(item.fullPath)
        }
        await refreshFileList(picker)
        clearValue(picker)
        showWithCurrentState(picker)
      } else {
        // User cancelled
        refilterFileList(picker)
        showWithCurrentState(picker)
      }
    })
}

///////////////////////////////////////////////////////////////////

type EntryType = 'file' | 'directory' | 'broken-symlink'

interface DirectoryEntry extends QuickPickItem {
  fullPath: string
  type: EntryType
}

async function openSelected(picker: FindFileState) {
  const item = currentItem(picker)
  if (!item) {
    // The current filter doesn't match -> create a new file
    const filePath = pathFromCurrentValue(picker)
    if (filePath !== undefined) {
      await createFileIfNotExists(filePath)
      openFile(filePath)
      picker.hide()
    }
  } else if (item.type === 'file') {
    openFile(item.fullPath)
    picker.hide()
  }
}

function currentDirectory(picker: FindFileState): string {
  if (picker.title === undefined) {
    throw new Error('picker.title is undefined!')
  }
  return picker.title
}

function currentItem(picker: FindFileState): DirectoryEntry | undefined {
  return picker.activeItems[0]
}

async function changeToDirectory(
  picker: FindFileState,
  dirPath: string
): Promise<void> {
  picker.title = dirPath
  await refreshFileList(picker)
}

function clearValue(picker: FindFileState) {
  picker.value = ''
  setContextFromValue(picker.value)
}

async function refreshFileList(picker: FindFileState) {
  picker.busy = true
  picker.items = await listFiles(currentDirectory(picker))
  picker.busy = false
}

// Force filtering to happen after manually changing value
function refilterFileList(picker: FindFileState) {
  // eslint-disable-next-line no-self-assign
  picker.items = picker.items
}

function showWithCurrentState(picker: FindFileState) {
  setContextFromValue(picker.value)
  picker.show()
}

function setContextFromValue(value: string) {
  setContext(ACTIVE_CONTEXT_VAR, true)
  setContext(EMPTY_CONTEXT_VAR, value === '')
}

async function maybeChangeTo(
  picker: FindFileState,
  where: string
): Promise<boolean> {
  if (where === '~' && process.env.HOME) {
    clearValue(picker)
    await changeToDirectory(picker, process.env.HOME)
    return true
  }
  if (where === '/') {
    clearValue(picker)
    await changeToDirectory(picker, '/')
    return true
  }
  return false
}

function pathFromCurrentValue(picker: FindFileState): string | undefined {
  if (picker.value) {
    return path.join(currentDirectory(picker), picker.value)
  }
  return undefined
}

function getInitialDirectory(): string {
  const currentDir = activeFileDirectory()
  if (currentDir !== undefined) return currentDir
  return process.env.HOME || '/'
}

async function listFiles(dir: string): Promise<DirectoryEntry[]> {
  const dirents = await fs.readdir(dir, { withFileTypes: true })
  const items = (
    await Promise.all(dirents.map(dirent => makeEntry(dir, dirent)))
  ).sort(cmpEntries)
  return dir !== '/' ? [parentFor(dir), ...items] : items
}

async function makeEntry(
  parentDir: string,
  entry: Dirent
): Promise<DirectoryEntry> {
  const fullPath = path.join(parentDir, entry.name)
  let type: EntryType
  try {
    const stats = await fs.stat(fullPath)
    type = stats.isDirectory() ? 'directory' : 'file'
  } catch (err) {
    type = 'broken-symlink'
  }
  const label = `${typeIcon(type)} ${entry.name}`
  return { label, fullPath, type }
}

function typeIcon(type: EntryType): string {
  switch (type) {
    case 'file':
      return '$(file-text)'
    case 'directory':
      return '$(file-directory)'
    case 'broken-symlink':
      return '$(circle-slash)'
  }
}

function parentFor(dir: string): DirectoryEntry {
  return {
    label: '$(file-directory) ..',
    fullPath: path.resolve(dir, '..'),
    type: 'directory',
  }
}

function cmpEntries(e1: DirectoryEntry, e2: DirectoryEntry): number {
  // Sort directories first
  if (e1.type === 'directory' && e2.type !== 'directory') {
    return -1
  }
  if (e2.type === 'directory' && e1.type !== 'directory') {
    return 1
  }
  return e1.label.localeCompare(e2.label)
}

async function createDirectoryIfNotExists(dirPath: string) {
  try {
    await fs.mkdir(dirPath)
  } catch (_err) {
    // Ignore
  }
}

async function createFileIfNotExists(filePath: string) {
  await fs.open(filePath, 'a')
}

function openFile(filePath: string) {
  workspace.openTextDocument(filePath).then(document => {
    window.showTextDocument(document)
  })
}

function splitPath(filePath: string): { dirName: string; fileName: string } {
  return { dirName: path.dirname(filePath), fileName: path.basename(filePath) }
}
