import { AssertionError, strict as assert } from 'assert'
import path from 'path'
import sinon from 'sinon'

import { workspaceRoot } from '.'
import config from '../../../config'
import * as direnv from '../../../direnv'

describe('direnv in the test workspace', function () {
	const file = path.resolve(workspaceRoot, '.envrc')

	it('finds the direnv executable', async function () {
		await direnv.test()
	})

	it('finds the .envrc file in the workspace root', async function () {
		const path = await direnv.find()
		assert.equal(path, file)
	})

	it('reuses the .envrc file in the workspace root', async function () {
		const path = await direnv.create()
		assert.equal(path, file)
	})

	it('dumps the allowed .envrc file', async function () {
		delete process.env.VARIABLE
		await direnv.allow(file)
		const data = await direnv.dump()
		assert.equal(data.get('VARIABLE'), 'value')
	})

	it('does not dump the extra environment', async function () {
		sinon.replace(config.extraEnv, 'get', () => ({ ['VARIABLE']: 'value' }))
		await direnv.allow(file)
		const data = await direnv.dump()
		assert.equal(data.get('VARIABLE'), undefined)
	})

	it('fails to dump the blocked .envrc file', async function () {
		await direnv.allow(file)
		await direnv.block(file)
		try {
			await direnv.dump()
			assert.fail('.envrc should be blocked')
		} catch (e) {
			if (e instanceof AssertionError) throw e
			assert(e instanceof direnv.BlockedError)
			assert.equal(e.path, file)
		}
	})

	it('lists the .envrc file as watched', async function () {
		this.retries(60) // XXX this test is flaky
		await direnv.allow(file)
		const data = await direnv.dump()
		const paths = direnv.watchedPaths(data)
		assert.ok(paths.includes(file))
	})

	it('fails when the direnv executable is missing', async function () {
		const missing = '/missing/executable'
		sinon.replace(config.path.executable, 'get', () => missing)
		await assert.rejects(() => direnv.test(), new direnv.CommandNotFoundError(missing))
	})

	it('dumps the allowed .envrc file while waiting', async function () {
		delete process.env.VARIABLE
		await direnv.allow(file)
		const started = direnv.dumpBlocking(5000)
		assert.equal(started.data?.get('VARIABLE'), 'value')
		await started.running
	})

	it('keeps dumping the allowed .envrc file after waiting', async function () {
		delete process.env.VARIABLE
		await direnv.allow(file)
		const started = direnv.dumpBlocking(0)
		assert.equal(started.data, undefined)
		const data = await direnv.dump(undefined, started.running)
		assert.equal(data.get('VARIABLE'), 'value')
	})

	it('fails to dump while waiting when the direnv executable is missing', async function () {
		const missing = '/missing/executable'
		sinon.replace(config.path.executable, 'get', () => missing)
		const started = direnv.dumpBlocking(5000)
		assert.equal(started.data, undefined)
		await assert.rejects(started.running, new direnv.CommandNotFoundError(missing))
	})
})
