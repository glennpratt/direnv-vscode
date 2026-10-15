import path from 'path'
import vscode from 'vscode'
import { Checksum } from './checksum'
import * as command from './command'
import config from './config'
import * as direnv from './direnv'
import { Data, isInternal } from './direnv'
import * as status from './status'

const enum Cached {
	checksum = 'direnv.checksum',
	environment = 'direnv.environment',
	cwdOverride = 'direnv.cwdOverride',
	restartedAt = 'direnv.restartedAt',
}
type EnvCache = [string, string | undefined][]

const installationUri = vscode.Uri.parse('https://direnv.net/docs/installation.html')

// environment changes this soon after restarting suggest a restart loop
const restartLoopWindow = 60_000

type Extensions = vscode.Extension<unknown>[]

class Direnv implements vscode.Disposable {
	private output = vscode.window.createOutputChannel('direnv')
	private backup = new Map<string, string | undefined>()
	private didLoad = new vscode.EventEmitter<Data>()
	private loaded = new vscode.EventEmitter<void>()
	private failed = new vscode.EventEmitter<unknown>()
	private blocked = new vscode.EventEmitter<direnv.BlockedError>()
	private viewBlocked = new vscode.EventEmitter<string>()
	private didUpdate = new vscode.EventEmitter<Extensions>()
	private blockedPath?: string
	private cwdOverride?: string
	private watchers = new Map<string, vscode.Disposable>()

	constructor(
		private context: vscode.ExtensionContext,
		private status: status.Item,
	) {
		this.didLoad.event((e) => this.onDidLoad(e))
		this.loaded.event(() => this.onLoaded())
		this.failed.event((e) => this.onFailed(e))
		this.blocked.event((e) => this.onBlocked(e))
		this.viewBlocked.event((e) => this.onViewBlocked(e))
		this.didUpdate.event((e) => this.onDidUpdate(e))
	}

	private get environment() {
		return this.context.environmentVariableCollection
	}

	private get cache() {
		return this.context.workspaceState
	}

	dispose() {
		this.output.dispose()
		this.status.dispose()
		for (const watcher of this.watchers.values()) {
			watcher.dispose()
		}
	}

	async allow(path: string) {
		await this.try(async () => {
			await direnv.allow(path)
			await this.onWillLoad()
		})
	}

	async block(path: string) {
		await this.try(async () => {
			await direnv.block(path)
			await this.onWillLoad()
		})
	}

	didOpen(path: string) {
		if (this.blockedPath === path) {
			this.viewBlocked.fire(path)
		}
	}

	async configurationChanged(event: vscode.ConfigurationChangeEvent) {
		if (!config.isAffectedBy(event)) return
		if (config.path.isAffectedBy(event) || config.extraEnv.isAffectedBy(event)) {
			await this.reload()
		}
		if (config.status.isAffectedBy(event)) {
			this.status.refresh()
		}
	}

	async create() {
		await this.open(await direnv.create())
	}

	async open(path?: string) {
		path ??= await direnv.find()
		const uri = await uriFor(path)
		await vscode.commands.executeCommand('vscode.open', uri)
		this.didOpen(path)
	}

	async loadEnvrc(uri?: vscode.Uri) {
		if (!uri) {
			const options: vscode.OpenDialogOptions = {
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				defaultUri: vscode.Uri.file(direnv.cwd()),
				filters: { ['.envrc']: ['envrc'] },
				openLabel: 'Load',
				title: 'Select .envrc to load',
			}
			const uris = await vscode.window.showOpenDialog(options)
			if (uris === undefined) return
			if (uris.length !== 1) return
			uri = uris[0]
		}

		if (path.basename(uri.path) !== '.envrc') {
			await vscode.window.showErrorMessage('direnv: Not a .envrc!')
			return
		}
		this.cwdOverride = path.dirname(uri.path)
		await this.try(() => this.onWillLoad())
	}

	async reload() {
		await this.resetCache()
		await this.load()
	}

	async reset() {
		this.resetEnvironment()
		await this.resetCache()
		await this.load()
	}

	restore() {
		const data = this.restoreCache()
		this.updateEnvironment(data)
		// wait for direnv now so that extensions activated after us don't need a restart
		const timeout = config.startup.timeout.get()
		const folder = this.cwdOverride ?? direnv.cwd()
		const start = Date.now()
		const started = direnv.dumpBlocking(timeout, this.cwdOverride)
		if (started.data === undefined) {
			this.output.appendLine(
				`startup: no environment for ${folder} within ${timeout}ms, loading in the background`,
			)
			void this.load(started.running)
			return
		}
		const changes = [...started.data.keys()].filter((it) => !isInternal(it)).length
		this.output.appendLine(
			`startup: direnv finished in ${Date.now() - start}ms for ${folder}, ${changes} variables changed`,
		)
		this.didLoad.fire(started.data)
		// let the regular load handle blocked files and catch up on changes
		void this.load()
	}

	private restoreCache(): Data | undefined {
		this.cwdOverride = this.cache.get<string>(Cached.cwdOverride)
		const checksum = this.cache.get<string>(Cached.checksum)
		if (checksum === undefined) return
		const entries = this.cache.get<EnvCache>(Cached.environment)
		if (!Array.isArray(entries)) return
		const data = new Map(entries.map(([key, value]) => [key, value ?? null]))
		const hash = new Checksum()
		for (const [key] of data) {
			hash.update(key, process.env[key])
		}
		if (checksum !== hash.digest()) return
		return data
	}

	private async updateCache() {
		const hash = new Checksum()
		const entries: EnvCache = []
		for (const [key, value] of this.backup) {
			hash.update(key, value)
			entries.push([key, process.env[key]])
		}
		await this.cache.update(Cached.checksum, hash.digest())
		await this.cache.update(Cached.environment, entries)
		await this.cache.update(Cached.cwdOverride, this.cwdOverride)
	}

	private async resetCache() {
		await this.cache.update(Cached.environment, undefined)
		await this.cache.update(Cached.cwdOverride, undefined)
	}

	private createWatcher(file: string) {
		const dirname = path.dirname(file)
		const basename = path.basename(file)
		const pattern = new vscode.RelativePattern(vscode.Uri.file(dirname), basename)
		const watcher = vscode.workspace.createFileSystemWatcher(pattern)
		watcher.onDidChange(() => this.reload())
		watcher.onDidCreate(() => this.reload())
		watcher.onDidDelete(() => this.reload())
		this.output.appendLine(`watching: ${file}`)
		return watcher
	}

	private updateWatchers(data?: Data) {
		// keep watchers for unchanged paths, new ones miss changes until they're live
		const paths = new Set(config.watchForChanges.get() ? direnv.watchedPaths(data) : [])
		for (const [file, watcher] of this.watchers) {
			if (paths.has(file)) continue
			watcher.dispose()
			this.watchers.delete(file)
		}
		for (const file of paths) {
			if (this.watchers.has(file)) continue
			this.watchers.set(file, this.createWatcher(file))
		}
	}

	private updateEnvironment(data?: Data) {
		if (data === undefined) return
		// Avoid updating the environment & cleaning out watchers if data is empty
		// such as when `direnv.dump()` is called twice without changes
		if (data.size === 0) return
		for (const [key, value] of data) {
			if (!this.backup.has(key)) {
				// keep the oldest value
				this.backup.set(key, process.env[key])
			}

			this.updateTerminalEnv(key, value)
			this.updateProcessEnv(key, value)
		}
		this.updateWatchers(data)
	}

	private resetEnvironment(data?: Data) {
		for (const [key, value] of this.backup) {
			this.updateProcessEnv(key, value)
		}
		this.backup.clear()
		this.environment.clear()
		this.cwdOverride = undefined
		this.updateWatchers(data)
	}

	private updateProcessEnv(key: string, value: string | null | undefined) {
		if (value === null || value === undefined) {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
			delete process.env[key]
		} else {
			process.env[key] = value
		}
	}

	private updateTerminalEnv(key: string, value: string | null) {
		if (value === null && this.backup.get(key) === undefined) {
			this.environment.delete(key)
		} else {
			this.environment.replace(key, value ?? '') // can't unset, set to empty instead
		}
	}

	private async load(running?: Promise<direnv.Stdio>) {
		await this.try(async () => {
			await direnv.test()
			await this.onWillLoad(running)
		})
	}

	private async try<T>(callback: () => Promise<T>) {
		try {
			await callback()
		} catch (err) {
			this.failed.fire(err)
		}
	}

	private async onWillLoad(running?: Promise<direnv.Stdio>) {
		this.blockedPath = undefined
		this.status.update(status.State.loading)
		try {
			const data = await direnv.dump(this.cwdOverride, running)
			this.didLoad.fire(data)
		} catch (err) {
			if (!(err instanceof direnv.BlockedError)) throw err
			this.blocked.fire(err)
		}
	}

	private async onDidLoad(data: Data) {
		// extensions active now started with the previous environment
		const stale = this.activeExtensions()
		this.updateEnvironment(data)
		await this.updateCache()
		this.loaded.fire()
		if ([...data.keys()].every(isInternal)) return
		this.didUpdate.fire(stale)
	}

	private activeExtensions(): Extensions {
		// built-in extensions don't usually depend on the custom environment
		const builtin = path.join(vscode.env.appRoot, 'extensions') + path.sep
		return vscode.extensions.all.filter(
			(it) =>
				it.isActive &&
				it.id !== this.context.extension.id &&
				!it.extensionUri.fsPath.startsWith(builtin),
		)
	}

	private onLoaded() {
		let state = status.State.empty
		if (this.backup.size) {
			let added = 0
			let changed = 0
			let removed = 0
			for (const [key, was] of this.backup) {
				if (isInternal(key)) continue
				if (was === undefined) {
					added += 1
					this.output.appendLine(`added: ${key}`)
				} else if (key in process.env) {
					changed += 1
					this.output.appendLine(`changed: ${key}`)
				} else {
					removed += 1
					this.output.appendLine(`removed: ${key}`)
				}
				if (was) {
					this.output.appendLine(`was: ${was}`)
				}
				const now = process.env[key]
				if (now) {
					this.output.appendLine(`now: ${now}`)
				}
			}

			state = status.State.loaded({
				added,
				changed,
				removed,
				currentFolder: this.cwdOverride,
			})
		}
		this.status.update(state)
	}

	private async onFailed(err: unknown) {
		this.status.update(status.State.failed)
		if (err instanceof direnv.CommandNotFoundError) {
			const options = ['Install', 'Configure']
			const choice = await vscode.window.showErrorMessage(
				`direnv error: ${err.message}`,
				...options,
			)
			if (choice === 'Install') {
				await vscode.env.openExternal(installationUri)
			}
			if (choice === 'Configure') {
				await config.path.executable.open()
			}
			return
		}
		const msg = message(err)
		if (msg !== undefined) {
			await vscode.window.showErrorMessage(`direnv error: ${msg}`)
		}
	}

	private async onBlocked(e: direnv.BlockedError) {
		this.blockedPath = e.path
		this.resetEnvironment(e.data)
		await this.resetCache()
		this.status.update(status.State.blocked(e.path))
		const options = ['Allow', 'View']
		const choice = await vscode.window.showWarningMessage(
			`direnv: ${e.path} is blocked`,
			...options,
		)
		if (choice === 'Allow') {
			await this.allow(e.path)
		}
		if (choice === 'View') {
			await this.open(e.path)
		}
	}

	private async onViewBlocked(path: string) {
		const choice = await vscode.window.showInformationMessage(
			`direnv: Allow ${path}?`,
			'Allow',
		)
		if (choice === 'Allow') {
			await this.allow(path)
		}
	}

	private async onDidUpdate(stale: Extensions) {
		if (stale.length === 0) {
			this.output.appendLine('no restart needed: no other extensions were active')
			return
		}
		const names = stale.map((it) => nameOf(it))
		this.output.appendLine(`active before the environment changed: ${names.join(', ')}`)
		if (await this.shouldRestart(names)) {
			await this.restart()
		}
	}

	private async shouldRestart(names: string[]) {
		const restartedAt = this.cache.get<number>(Cached.restartedAt) ?? 0
		const looping = Date.now() - restartedAt < restartLoopWindow
		if (config.restart.automatic.get() && !looping && !this.isDebugging()) return true
		const which =
			names.length > 3 ? `${names.slice(0, 3).join(', ')}, …` : names.join(', ')
		const msg = looping
			? `direnv: Environment changed again right after restarting extensions (${which}). ` +
				'The direnv output lists the changed variables. Restart again?'
			: `direnv: Environment updated. Restart extensions (${which})?`
		const choice = await vscode.window.showWarningMessage(msg, 'Restart')
		return choice === 'Restart'
	}

	// restarting would end debug sessions, adapters often run in the extension host
	private isDebugging() {
		return vscode.debug.activeDebugSession !== undefined
	}

	private async restart() {
		await this.cache.update(Cached.restartedAt, Date.now())
		// restarting a remote extension host drops the connection (#95, still in VS Code 1.141)
		if (vscode.env.remoteName === undefined) {
			await vscode.commands.executeCommand('workbench.action.restartExtensionHost')
		} else {
			await vscode.commands.executeCommand('workbench.action.reloadWindow')
		}
	}
}

function nameOf(extension: vscode.Extension<unknown>) {
	const { displayName } = extension.packageJSON as { displayName?: unknown }
	if (typeof displayName !== 'string') return extension.id
	// localized names are placeholders like %displayName%
	if (displayName.startsWith('%')) return extension.id
	return displayName
}

function message(err: unknown) {
	if (typeof err === 'string') return err
	if (err instanceof Error) return err.message
	console.error('unhandled error', err)
	return
}

async function uriFor(path: string) {
	const uri = vscode.Uri.file(path)
	try {
		await vscode.workspace.fs.stat(uri)
		return uri
	} catch (_) {
		return uri.with({ scheme: 'untitled' })
	}
}

export function activate(context: vscode.ExtensionContext) {
	const statusItem = new status.Item(vscode.window.createStatusBarItem())
	const instance = new Direnv(context, statusItem)
	context.subscriptions.push(instance)
	context.subscriptions.push(
		vscode.commands.registerCommand(command.Direnv.reload, async () => {
			await instance.reload()
		}),
		vscode.commands.registerCommand(command.Direnv.reset, async () => {
			await instance.reset()
		}),
		vscode.commands.registerCommand(command.Direnv.allow, async () => {
			const path = vscode.window.activeTextEditor?.document.fileName
			if (path !== undefined) {
				await instance.allow(path)
			}
		}),
		vscode.commands.registerCommand(command.Direnv.block, async () => {
			const path = vscode.window.activeTextEditor?.document.fileName
			if (path !== undefined) {
				await instance.block(path)
			}
		}),
		vscode.commands.registerCommand(command.Direnv.create, async () => {
			await instance.create()
		}),
		vscode.commands.registerCommand(command.Direnv.open, async () => {
			await instance.open()
		}),
		vscode.commands.registerCommand(
			command.Direnv.loadEnvrc,
			async (uri?: vscode.Uri) => {
				await instance.loadEnvrc(uri)
			},
		),
		vscode.window.tabGroups.onDidChangeTabs((e) => {
			for (const tab of e.opened) {
				if (tab.input instanceof vscode.TabInputText) {
					instance.didOpen(tab.input.uri.path)
				}
			}
		}),
		vscode.workspace.onDidOpenTextDocument((e) => {
			instance.didOpen(e.fileName)
		}),
		vscode.workspace.onDidChangeConfiguration(async (e) => {
			await instance.configurationChanged(e)
		}),
	)
	instance.restore()
}

export function deactivate() {
	// nothing
}
