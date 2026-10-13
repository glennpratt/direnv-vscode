import { strict as assert } from 'assert'

// read when mocha loads this file, before any hooks reload the environment
const variable = process.env.VARIABLE

describe('starting in the allowed test workspace', function () {
	it('loads the custom environment during activation', function () {
		assert.equal(variable, 'value')
	})
})
