import cp from 'child_process'
import os from 'os'
import { promisify } from 'util'
import vscode from 'vscode'
import { MessageChannel, Worker, receiveMessageOnPort } from 'worker_threads'
import zlib from 'zlib'
import config from './config'

const execFile = promisify(cp.execFile)

export class BlockedError extends Error {
	constructor(
		public readonly path: string,
		public readonly data: Data,
	) {
		super(`${path} is blocked`)
	}
}

export class CommandNotFoundError extends Error {
	constructor(public readonly path: string) {
		super(`${path}: command not found`)
	}
}

export type Data = Map<string, string | null>

type Watch = {
	path?: string
	['Path']?: string
}

export type Stdio = {
	stdout: string
	stderr: string
}

function isStdio(e: unknown): e is Stdio {
	if (typeof e !== 'object' || e === null) {
		return false
	}
	return 'stdout' in e && 'stderr' in e
}

function isCommandNotFound(e: unknown, path: string): boolean {
	if (!(e instanceof Error)) return false
	if (!('path' in e) || !('code' in e)) return false
	return e.path === path && e.code === 'ENOENT'
}

const echo = {
	['EDITOR']: 'echo',
}

export function cwd(): string {
	return vscode.workspace.workspaceFolders?.[0].uri.fsPath ?? os.homedir()
}

function execOptions(
	env?: NodeJS.ProcessEnv,
	cwdOverride?: string,
): cp.ExecOptionsWithStringEncoding {
	return {
		encoding: 'utf8',
		cwd: cwdOverride ?? cwd(),
		env: {
			...process.env,
			['TERM']: 'dumb',
			...env,
			...config.extraEnv.get(),
		},
	}
}

async function direnv(
	args: string[],
	env?: NodeJS.ProcessEnv,
	cwdOverride?: string,
): Promise<Stdio> {
	const options = execOptions(env, cwdOverride)
	const command = config.path.executable.get()
	try {
		return await execFile(command, args, options)
	} catch (e) {
		if (isCommandNotFound(e, command)) {
			throw new CommandNotFoundError(command)
		}
		throw e
	}
}

export async function test(): Promise<void> {
	await direnv(['version'])
}

export async function allow(path: string): Promise<void> {
	await direnv(['allow', path])
}

export async function block(path: string): Promise<void> {
	await direnv(['deny', path])
}

export async function create(): Promise<string> {
	const { stdout } = await direnv(['edit', cwd()], echo)
	return stdout.trimEnd()
}

export async function find(): Promise<string> {
	try {
		const { stdout } = await direnv(['edit'], echo)
		return stdout.trimEnd()
	} catch (e) {
		if (isStdio(e)) {
			const found = /direnv: error (?<path>.+) not found./.exec(e.stderr)
			if (found) {
				// .envrc not found, create a new one
				return create()
			}
		}
		throw e
	}
}

export type Started = {
	// the environment, if direnv finished while we were waiting
	data?: Data
	// the export to pass on to `dump`
	running: Promise<Stdio>
}

// Lets the export run in a worker thread so we can wait for it synchronously
// without killing direnv when it takes longer, e.g. to build a nix shell.
const exportWorker = `
const { execFile } = require('child_process')
const { workerData } = require('worker_threads')
const { command, args, options, done, port } = workerData
execFile(command, args, options, (error, stdout, stderr) => {
	port.postMessage(error
		? { error: { message: error.message, code: error.code, path: error.path, stdout, stderr } }
		: { stdout, stderr })
	Atomics.store(done, 0, 1)
	Atomics.notify(done, 0)
})
`

type ExportResult = Stdio & {
	error?: Stdio & { message: string; code?: unknown; path?: unknown }
}

// Starts `direnv export json` and blocks the extension host for up to
// `timeout` milliseconds waiting for it, so that extensions activated after us
// start with the custom environment.
export function dumpBlocking(timeout: number, cwdOverride?: string): Started {
	const command = config.path.executable.get()
	const args = ['export', 'json']
	const done = new Int32Array(new SharedArrayBuffer(4))
	const { port1, port2 } = new MessageChannel()
	let settle: (result: ExportResult) => void = () => undefined
	const running = new Promise<Stdio>((ok, fail) => {
		settle = ({ error, stdout, stderr }) => {
			if (error === undefined) return ok({ stdout, stderr })
			if (error.code === 'ENOENT' && error.path === command) {
				return fail(new CommandNotFoundError(command))
			}
			fail(Object.assign(new Error(error.message), error))
		}
	})
	try {
		const workerData = {
			command,
			args,
			options: execOptions(undefined, cwdOverride),
			done,
			port: port2,
		}
		new Worker(exportWorker, { eval: true, workerData, transferList: [port2] }).unref()
	} catch (_) {
		// no worker threads, don't wait
		return { running: direnv(args, undefined, cwdOverride) }
	}
	// callers may never get to await a failed export, e.g. when direnv is missing
	running.catch(() => undefined)
	const finished = timeout > 0 && Atomics.wait(done, 0, 0, timeout) !== 'timed-out'
	const result = finished
		? (receiveMessageOnPort(port1)?.message as ExportResult | undefined)
		: undefined
	if (result !== undefined) {
		port1.close()
		settle(result)
		if (result.error !== undefined) return { running }
		try {
			return { data: parse(result.stdout), running }
		} catch (_) {
			return { running }
		}
	}
	port1.once('message', (result: ExportResult) => {
		port1.close()
		settle(result)
	})
	return { running }
}

export async function dump(
	cwdOverride?: string,
	running?: Promise<Stdio>,
): Promise<Data> {
	let stdout: string
	try {
		running ??= direnv(['export', 'json'], undefined, cwdOverride)
		stdout = (await running).stdout
	} catch (e) {
		if (isStdio(e)) {
			const found = /direnv: error (?<path>.+) is blocked./.exec(e.stderr)
			if (found?.groups?.path) {
				// .envrc is blocked, let caller ask user what to do
				throw new BlockedError(found.groups.path, parse(e.stdout, isInternal))
			}
		}
		throw e
	}
	// since direnv 2.33 denied files unload silently instead of failing
	const denied = await deniedPath(cwdOverride)
	if (denied !== undefined) {
		throw new BlockedError(denied, parse(stdout, isInternal))
	}
	return parse(stdout)
}

const enum Allowed {
	denied = 2,
}

type Status = {
	state?: {
		foundRC?: {
			allowed?: number
			path?: string
		} | null
	}
}

async function deniedPath(cwdOverride?: string): Promise<string | undefined> {
	let status: Status
	try {
		const { stdout } = await direnv(['status', '--json'], undefined, cwdOverride)
		status = JSON.parse(stdout) as Status
	} catch (_) {
		// older direnv has no `status --json`, but it reports denied files from `export`
		return
	}
	const found = status.state?.foundRC
	if (found?.allowed !== Allowed.denied) return
	return found.path
}

function parse(stdout: string, predicate: (key: string) => boolean = () => true): Data {
	if (!stdout) return new Map()
	const record = JSON.parse(stdout) as Record<string, string>
	return new Map(Object.entries(record).filter(([key]) => predicate(key)))
}

export function isInternal(key: string) {
	return key.startsWith('DIRENV_')
}

export function watchedPaths(data?: Data): string[] {
	if (data === undefined) return []
	const watches: Watch[] = decode(data.get('DIRENV_WATCHES')) ?? []
	return watches.map((it) => it.path ?? it.Path).filter((it): it is string => !!it)
}

function decode<T>(gzenv?: string | null): T | undefined {
	if (!gzenv) return undefined
	const deflated = Buffer.from(gzenv, 'base64url')
	const inflated = zlib.inflateSync(deflated)
	const json = inflated.toString('utf8')
	return JSON.parse(json) as T
}
