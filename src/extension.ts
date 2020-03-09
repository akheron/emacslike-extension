import { ExtensionContext, commands } from 'vscode'
import * as ag from './ag'
import * as findfile from './findfile'

export function activate(context: ExtensionContext) {
  activateAg(context)
  activateFindfile(context)
}

function activateAg(context: ExtensionContext) {
  const state = ag.init()
  context.subscriptions.push(
    state,
    commands.registerCommand('emacslike.ag.show', () => {
      ag.show(state)
    }),
    commands.registerCommand('emacslike.ag.open', () => {
      ag.open(state)
    }),
    commands.registerCommand('emacslike.ag.peek', () => {
      ag.peek(state)
    }),
    commands.registerCommand('emacslike.ag.refresh', () => {
      ag.refresh(state)
    }),
    commands.registerCommand('emacslike.ag.stopSearch', () => {
      ag.stopSearch(state)
    })
  )
}

function activateFindfile(context: ExtensionContext) {
  const state = findfile.init()
  context.subscriptions.push(
    state,
    commands.registerCommand('emacslike.findfile.show', () => {
      findfile.show(state)
    }),
    commands.registerCommand('emacslike.findfile.select', () => {
      findfile.select(state)
    }),
    commands.registerCommand('emacslike.findfile.goToParent', () => {
      findfile.goToParent(state)
    }),
    commands.registerCommand('emacslike.findfile.openPartial', () => {
      findfile.openPartial(state)
    }),
    commands.registerCommand(
      'emacslike.findfile.createDirectoryPartial',
      () => {
        findfile.createDirectoryPartial(state)
      }
    ),
    commands.registerCommand('emacslike.findfile.rename', () => {
      findfile.rename(state)
    }),
    commands.registerCommand('emacslike.findfile.remove', () => {
      findfile.remove(state)
    })
  )
}
