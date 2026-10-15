import path from 'path'
import sinon, { SinonStub, match } from 'sinon'

import vscode from 'vscode'

import { workspaceRoot } from '.'
import { assertEnvironmentIsLoaded } from '../assertions'

context('restarting extensions in the test workspace', function () {
	const restartCommands = ['workbench.action.restartExtensionHost', 'workbench.action.reloadWindow']
	let executeCommand: SinonStub

	beforeEach(async function () {
		// start unloaded so that allowing changes the environment
		await vscode.commands.executeCommand('direnv.reset')
		const file = path.join(workspaceRoot, 'file.txt')
		await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file))
		executeCommand = sinon.stub(vscode.commands, 'executeCommand').callThrough()
		for (const command of restartCommands) {
			executeCommand.withArgs(command).resolves(undefined)
		}
	})

	function restarted() {
		return restartCommands.some((command) => executeCommand.calledWith(command))
	}

	function otherExtensionIsActive() {
		const other = {
			id: 'test.other',
			isActive: true,
			extensionUri: vscode.Uri.file('/test/other'),
			packageJSON: { displayName: 'Other' },
		}
		sinon.replaceGetter(vscode.extensions, 'all', () => [other] as vscode.Extension<unknown>[])
	}

	specify('without other active extensions it does not offer restarting', async function () {
		await vscode.commands.executeCommand('direnv.allow')
		await assertEnvironmentIsLoaded()
		sinon.assert.neverCalledWithMatch(vscode.window.showWarningMessage as SinonStub, match.any, 'Restart')
		sinon.assert.match(restarted(), false)
	})

	specify('with other active extensions it offers restarting them', async function () {
		otherExtensionIsActive()
		await vscode.commands.executeCommand('direnv.allow')
		await assertEnvironmentIsLoaded()
		sinon.assert.calledWithMatch(vscode.window.showWarningMessage as SinonStub, match(/\(Other\)/), 'Restart')
		sinon.assert.match(restarted(), false)
	})

	// the extension is bundled separately, so change the actual setting
	async function restartAutomatically(value?: boolean) {
		const settings = vscode.workspace.getConfiguration('direnv')
		await settings.update('restart.automatic', value, vscode.ConfigurationTarget.Global)
	}

	// keep last, the restart is remembered for a while
	specify('it restarts automatically, but not again right away', async function () {
		otherExtensionIsActive()
		await restartAutomatically(true)
		try {
			await vscode.commands.executeCommand('direnv.allow')
			await assertEnvironmentIsLoaded()
			sinon.assert.match(restarted(), true)

			executeCommand.resetHistory()
			await vscode.commands.executeCommand('direnv.block')
			await vscode.commands.executeCommand('direnv.allow')
			await assertEnvironmentIsLoaded()
			sinon.assert.match(restarted(), false)
			sinon.assert.calledWithMatch(vscode.window.showWarningMessage as SinonStub, match(/changed again/), 'Restart')
		} finally {
			await restartAutomatically(undefined)
		}
	})
})
