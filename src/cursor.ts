import { window } from 'vscode'

export function cursorToNextSubword() {
  const editor = window.activeTextEditor
  if (!editor) return
  const cursor = editor.selection.active
  const line = editor.document.lineAt(cursor)
  line.text[cursor.character]
  console.log(line)
}

export function cursorToPrevSubword() {
  console.log('TODO foo bar')
}
