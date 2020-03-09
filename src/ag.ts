import {
  EventEmitter,
  TextDocumentContentProvider,
  Uri,
  window,
  workspace,
  languages,
  Selection,
  Position,
  ViewColumn,
  Range,
  TextEditorRevealType,
  DocumentHighlight,
  DocumentHighlightKind,
  DocumentHighlightProvider,
  Event,
  Disposable,
  StatusBarAlignment,
  StatusBarItem,
  QuickPick,
  QuickPickItem,
} from 'vscode'
import * as path from 'path'
import * as childProcess from 'child_process'
import {
  activeFileDirectory,
  findProjectRoot,
  setContext,
  getCurrentSelectionText,
} from './utils'

const SCHEME = 'ag'
const URI = `${SCHEME}:///ag-output`
const CONTEXT_VAR = 'emacslike.ag.active'
const SELECTOR = { language: 'ag-output' }

export interface AgState
  extends TextDocumentContentProvider,
    DocumentHighlightProvider {
  searchState: AgSearchState | undefined
  searchResult: AgSearchResult | undefined
  isActiveEditor: boolean // is the ag search results the active editor
  quickPick: QuickPick<QuickPickItem>
  statusBarItem: StatusBarItem
  emitChange(): void
  dispose(): void
}

export function init(): AgState {
  const onDidChange = new EventEmitter<Uri>()
  const quickPick = window.createQuickPick<QuickPickItem>()

  const state: AgState = {
    searchState: undefined,
    searchResult: undefined,
    isActiveEditor: false,
    quickPick: quickPick,
    statusBarItem: createStatusBarItem(),
    emitChange() {
      onDidChange.fire(Uri.parse(URI))
    },
    dispose() {
      this.searchResult = undefined
      registrations.dispose()
    },
    get onDidChange() {
      return onDidChange.event
    },
    provideTextDocumentContent(): string {
      const searchResult = this.searchResult
      if (searchResult === undefined) return ''
      return renderSearchResults(searchResult)
    },
    provideDocumentHighlights() {
      const searchResult = this.searchResult
      if (searchResult === undefined) return undefined
      return generateHighlights(searchResult)
    },
  }
  initQuickPick(state)

  const registrations = Disposable.from(
    onDidChange,
    quickPick,
    state.statusBarItem,
    workspace.registerTextDocumentContentProvider(SCHEME, state),
    languages.registerDocumentHighlightProvider(SELECTOR, state),
    window.onDidChangeActiveTextEditor(editor => {
      if (!editor) return
      if (editor.document.uri.scheme === SCHEME) {
        state.isActiveEditor = true
        setContext(CONTEXT_VAR, true)
      } else {
        state.isActiveEditor = false
        setContext(CONTEXT_VAR, false)
      }
    })
  )

  return state
}

export function show(state: AgState) {
  const searchRootDir = getSearchRootDir(state)
  const initialSearchPattern = getInitialSearchPattern(state)
  initSearch(state, searchRootDir, initialSearchPattern)

  workspace
    .openTextDocument(Uri.parse(URI))
    .then(doc => languages.setTextDocumentLanguage(doc, 'ag-output'))
    .then(doc => window.showTextDocument(doc))
    .then(() => {
      state.quickPick.value = initialSearchPattern
      state.quickPick.show()
      if (shouldSearchForPattern(state, initialSearchPattern)) {
        refineSearch(state, initialSearchPattern)
      }
    })
}

function getSearchRootDir(state: AgState): string {
  if (state.isActiveEditor && state.searchResult) {
    return state.searchResult.dirPath
  }
  const activeDirPath = activeFileDirectory()
  if (activeDirPath !== undefined) {
    return findProjectRoot(activeDirPath)
  }
  return '/'
}

function getInitialSearchPattern(state: AgState): string {
  if (state.isActiveEditor && state.searchResult) {
    return state.searchResult.pattern
  }
  if (window.activeTextEditor !== undefined) {
    return getCurrentSelectionText(window.activeTextEditor)
  }
  return ''
}

export function open(state: AgState, preserveFocus = false) {
  const index = currentMatchIndex()
  if (state.searchResult === undefined || index === undefined) return

  const targetColumn = getPeekColumn()
  if (!preserveFocus) {
    // Close the search window
    window.activeTextEditor?.hide()
  }

  const match = state.searchResult.matches[index]
  const position = new Position(match.lineNo - 1, 0)
  workspace
    .openTextDocument(path.join(state.searchResult.dirPath, match.filePath))
    .then(doc => window.showTextDocument(doc, targetColumn, preserveFocus))
    .then(editor => {
      editor.revealRange(
        new Range(position, position),
        TextEditorRevealType.InCenter
      )
      editor.selection = new Selection(position, position)
    })
}

export function peek(state: AgState) {
  open(state, true)
}

export function refresh(state: AgState) {
  if (state.searchResult !== undefined) {
    const { pattern } = state.searchResult
    refineSearch(state, pattern)
  }
}

export function stopSearch(state: AgState) {
  const searchState = state.searchState
  if (searchState !== undefined) {
    searchState.proc.kill()
  }
}

///////////////////////////////////////////////////////////////////

interface AgSearchState {
  proc: AgProc
  dispose: () => void
}

interface AgSearchResult {
  dirPath: string
  pattern: string
  matches: AgMatch[]
  inProgress: boolean
  truncated: boolean
}

interface AgMatch {
  filePath: string
  lineNo: number
  text: string
}

function initSearch(state: AgState, dirPath: string, pattern: string): void {
  killSearch(state)

  state.searchResult = {
    dirPath,
    pattern,
    matches: [],
    inProgress: true,
    truncated: false,
  }
  state.quickPick.title = `Seach in ${dirPath}`
  state.emitChange()
}

function refineSearch(state: AgState, pattern: string): void {
  killSearch(state)

  const searchResult = state.searchResult
  if (searchResult === undefined) return

  searchResult.pattern = pattern
  searchResult.matches = []
  searchResult.inProgress = true
  searchResult.truncated = false

  const matches = searchResult.matches
  state.emitChange()

  showStatusBarItem(state)
  const agProc = spawnAg(searchResult.dirPath, pattern)

  let prevMatchCount = -1 // force refresh the first time
  const intervalHandle = setInterval(() => {
    if (matches.length != prevMatchCount) {
      prevMatchCount = matches.length
      state.emitChange()
    }
  }, 1000)

  const subscriptions = Disposable.from(
    agProc.onMatch(match => {
      if (matches.length < 1000) {
        matches.push(match)
      } else {
        // We don't want more than 1000 matches
        stopSearch(state)
        searchResult.truncated = true
      }
    }),
    agProc.onExit(() => {
      clearInterval(intervalHandle)
      hideStatusBarItem(state)
      searchResult.inProgress = false
      state.searchState = undefined
      state.emitChange()
    })
  )

  // Disposing the searchState will cancel event subscriptions
  state.searchState = {
    proc: agProc,
    dispose: () => subscriptions.dispose(),
  }
}

function killSearch(state: AgState) {
  // Kill the search and do not receive any events anymore
  const { searchState } = state
  if (searchState !== undefined) {
    searchState.proc.kill()
    searchState.dispose()
    state.statusBarItem.hide()
    state.searchState = undefined
  }
}

interface AgProc {
  proc: childProcess.ChildProcess
  onMatch: Event<AgMatch>
  onExit: Event<void>
  kill(): void
}

function spawnAg(dirPath: string, pattern: string): AgProc {
  const onMatch = new EventEmitter<AgMatch>()
  const onExit = new EventEmitter<void>()

  const proc = childProcess.spawn(
    'ag',
    ['--hidden', '--ignore', '.git', '--nogroup', pattern],
    {
      cwd: dirPath,
      stdio: ['ignore', 'pipe', 'ignore'],
    }
  )

  let running = true
  let killed = false

  const kill = () => {
    if (!killed) {
      killed = true
      if (running) {
        proc.kill()
      }
    }
  }

  const agProc: AgProc = {
    proc,
    onMatch: onMatch.event,
    onExit: onExit.event,
    kill,
  }

  const processAgOutputLine = (line: string) => {
    const match = parseAgOutputLine(line)
    if (match !== undefined) {
      onMatch.fire(match)
    }
  }

  let previous = ''
  proc.stdout.on('data', chunk => {
    previous += chunk
    let eolIndex
    while ((eolIndex = previous.indexOf('\n')) >= 0) {
      // yield the line without eol
      const line = previous.slice(0, eolIndex)
      if (!killed) {
        processAgOutputLine(line)
      }
      previous = previous.slice(eolIndex + 1)
    }
  })

  proc.on('exit', () => {
    running = false
    if (previous.length > 0 && !killed) {
      processAgOutputLine(previous)
    }
    onExit.fire()

    onMatch.dispose()
    onExit.dispose()
  })

  return agProc
}

function parseAgOutputLine(line: string): AgMatch | undefined {
  const reMatch = /^(.+?):(\d+):(.*)$/.exec(line)
  if (reMatch === null) return undefined
  return {
    filePath: reMatch[1],
    lineNo: parseInt(reMatch[2], 10),
    // Truncate long lines to 300 characters
    text: truncateLine(reMatch[3], 300),
  }
}

function truncateLine(line: string, maxLength: number): string {
  return line.length > maxLength ? line.slice(0, maxLength - 3) + '...' : line
}

function renderSearchResults(searchResult: AgSearchResult): string {
  const { pattern, dirPath, matches, inProgress, truncated } = searchResult
  return (
    renderTitle(inProgress, pattern, dirPath) +
    '\n' +
    matches.map(renderMatch).join('\n') +
    '\n' +
    renderFooter(inProgress, matches.length, truncated)
  )
}

function renderTitle(inProgress: boolean, pattern: string, dirPath: string) {
  return inProgress
    ? renderInProgressTitle(pattern, dirPath)
    : renderFinishedTitle(pattern, dirPath)
}

function renderInProgressTitle(pattern: string, dirPath: string): string {
  return `--- Searching for ${pattern} in ${dirPath}... ---`
}

function renderFinishedTitle(pattern: string, dirPath: string): string {
  return `--- Search results for ${pattern} in ${dirPath} ---`
}

function renderMatch(match: AgMatch) {
  return `${match.filePath}:${match.lineNo}:${match.text}`
}

function renderFooter(
  inProgress: boolean,
  matchCount: number,
  truncated: boolean
) {
  if (inProgress) return ''
  if (truncated) return `(stopped after reaching ${matchCount} results)`
  return `(${matchCount} results)`
}

function currentMatchIndex(): number | undefined {
  const activeEditor = window.activeTextEditor
  if (!activeEditor) return undefined

  const cursor = activeEditor.selection.active
  if (cursor.line < 1) return undefined

  // The first line contains the title
  return cursor.line - 1
}

function getPeekColumn(): ViewColumn | undefined {
  const numEditors = window.visibleTextEditors.length
  const activeColumn = window.activeTextEditor?.viewColumn

  if (activeColumn === undefined) {
    return undefined
  }
  if (numEditors === 1) {
    return ViewColumn.Beside
  }
  const nonActive = [
    ViewColumn.One,
    ViewColumn.Two,
    ViewColumn.Three,
    ViewColumn.Four,
    ViewColumn.Five,
    ViewColumn.Six,
    ViewColumn.Seven,
    ViewColumn.Eight,
    ViewColumn.Nine,
  ].filter(c => c !== activeColumn)
  if (!nonActive.length) return ViewColumn.Beside
  return nonActive[0]
}

function generateHighlights(searchResult: AgSearchResult) {
  const { pattern, matches } = searchResult

  return matches
    .map((match, index) => {
      const regex = new RegExp(pattern, 'ig')
      const highlights: DocumentHighlight[] = []
      let matchResult: RegExpExecArray | null
      while ((matchResult = regex.exec(match.text)) !== null) {
        const start = matchResult.index
        const end = start + matchResult[0].length
        highlights.push(highlightFor(match, index, start, end))
      }
      return highlights
    })
    .flat()
}

function highlightFor(
  match: AgMatch,
  matchIndex: number,
  start: number,
  end: number
): DocumentHighlight {
  // The matched line start from offset
  // filePath:lineNo:  <-- +2 for the colons
  const offset = match.filePath.length + match.lineNo.toString().length + 2

  // A heading is printed on the first line, thus +1
  const line = matchIndex + 1
  const range = new Range(line, offset + start, line, offset + end)

  return new DocumentHighlight(range, DocumentHighlightKind.Read)
}

function initQuickPick(state: AgState) {
  const { quickPick } = state
  quickPick.items = []
  quickPick.placeholder = 'Search...'

  let timerHandle: NodeJS.Timeout | undefined = undefined

  function cancelTimeout() {
    if (timerHandle) {
      clearTimeout(timerHandle)
      timerHandle = undefined
    }
  }

  quickPick.onDidChangeValue(value => {
    cancelTimeout()
    if (shouldSearchForPattern(state, value)) {
      timerHandle = setTimeout(() => {
        refineSearch(state, value)
      }, 1000)
    }
  })
  quickPick.onDidAccept(() => {
    cancelTimeout()
    if (hasPatternChanged(state, quickPick.value)) {
      refineSearch(state, quickPick.value)
    }
    quickPick.hide()
  })
  quickPick.onDidHide(() => {
    cancelTimeout()
  })
  return quickPick
}

function shouldSearchForPattern(state: AgState, pattern: string): boolean {
  return pattern.length >= 3 && hasPatternChanged(state, pattern)
}

function hasPatternChanged(state: AgState, pattern: string): boolean {
  return pattern !== state.searchResult?.pattern
}

function createStatusBarItem(): StatusBarItem {
  const statusBarItem = window.createStatusBarItem(StatusBarAlignment.Left)
  statusBarItem.command = 'emacslike.ag.stopSearch'
  statusBarItem.text = '$(search) ag'
  statusBarItem.tooltip = 'Searching, click to stop...'
  return statusBarItem
}

function showStatusBarItem(state: AgState): void {
  state.statusBarItem.show()
}

function hideStatusBarItem(state: AgState): void {
  state.statusBarItem.hide()
}
