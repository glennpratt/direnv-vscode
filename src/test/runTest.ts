import cp from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { runTests } from '@vscode/test-electron'

const allSuites = ['startup', 'commands', 'direnv', 'environment', 'interface']
const workspaces = ['.', 'subdir']

const extensionDevelopmentPath = path.resolve(__dirname, '../..')
const extensionTestsEnv = { ['PREDEFINED']: 'value' }

type Options = {
	args?: string[]
	env?: Record<string, string>
}

async function test(extensionTestsPath: string, workspacePath: string, options: Options = {}) {
	const disableExtensions = '--disable-extensions'
	const launchArgs = [workspacePath, disableExtensions, ...(options.args ?? [])]
	const env = { ...extensionTestsEnv, ...options.env }
	await runTests({ extensionDevelopmentPath, extensionTestsPath, extensionTestsEnv: env, launchArgs })
}

// start with a slow .envrc allowed and nothing cached from earlier runs
function startupOptions(suite: string, workspacePath: string): Options {
	if (suite !== 'startup') return {}
	cp.execFileSync('direnv', ['allow', workspacePath])
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'direnv-vscode-'))
	return {
		args: [`--user-data-dir=${userData}`],
		env: { ['TEST_ENVRC_DELAY']: '1' },
	}
}

async function main(suites: string[]) {
	let failed = false
	for (const suite of suites) {
		for (const workspace of workspaces) {
			const suitePath = path.resolve(__dirname, `suite/${suite}/${workspace}/`)
			const workspacePath = path.resolve(__dirname, `../../test/workspace/${workspace}`)
			if (!fs.existsSync(suitePath)) continue
			try {
				await test(suitePath, workspacePath, startupOptions(suite, workspacePath))
			} catch (err) {
				failed = true
			}
		}
	}
	if (failed) {
		console.error('Failed to run tests')
		process.exit(1)
	}
}

const [, , ...suites] = process.argv
void main(suites.length ? suites : allSuites)
