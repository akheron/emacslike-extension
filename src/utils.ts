import { commands, window, TextEditor, Range } from 'vscode'
import * as fs from 'fs'
import * as path from 'path'

// Set a `when` context variable for keybindings
export function setContext(varName: string, value: string | boolean) {
  commands.executeCommand('setContext', varName, value)
}

// Find the project root from a directory path inside the project.
// Currenly, checks for .git and package.json
export function findProjectRoot(dirPath: string): string {
  let current = dirPath
  while (current !== '/') {
    if (isProjectRoot(current)) break
    current = path.dirname(current)
  }
  return current
}

function isProjectRoot(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, '.git'))
}

export function activeFilePath(): string | undefined {
  return window.activeTextEditor?.document.uri.fsPath
}

export function activeFileDirectory(): string | undefined {
  const filePath = activeFilePath()
  if (filePath !== undefined) return path.dirname(filePath)
  return undefined
}

// Returns an empty string if nothing's selected
export function getCurrentSelectionText(editor: TextEditor): string {
  return editor.document.getText(
    new Range(editor.selection.anchor, editor.selection.active)
  )
}
