import assert from 'node:assert/strict';
import process from 'node:process';
import {setImmediate} from 'node:timers';
import jitiFactory from 'jiti';

const jiti = jitiFactory(import.meta.url);
const obsidianRuntime = jiti('obsidian');
obsidianRuntime.normalizePath = (value) => value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
const {appendLogLine, endLogBlock, getDailyLogFilePath, startLogBlock} = jiti('../src/logger.ts');

function flushTasks() {
	return new Promise((resolve) => setImmediate(resolve));
}

function createDeferredAdapter() {
	let persisted = '';
	let active = 0;
	let maxActive = 0;
	const pending = [];

	function defer(type, value) {
		active += 1;
		maxActive = Math.max(maxActive, active);
		return new Promise((resolve, reject) => {
			pending.push({
				type,
				settle(error) {
					active -= 1;
					if (error) reject(error);
					else {
						if (type === 'write') persisted = value;
						resolve(type === 'read' ? persisted : undefined);
					}
				},
			});
		});
	}

	return {
		adapter: {
			exists: async () => true,
			read: async () => defer('read'),
			write: async (_path, text) => defer('write', text),
		},
		get active() { return active; },
		get maxActive() { return maxActive; },
		get pending() { return pending; },
		get persisted() { return persisted; },
	};
}

async function settleNext(control, type, error) {
	await flushTasks();
	const operation = control.pending.shift();
	assert.equal(operation?.type, type, `expected pending ${type}`);
	operation.settle(error);
	await flushTasks();
}

async function testLogWritesAreSerializedInCallOrder() {
	const control = createDeferredAdapter();
	const app = {vault: {adapter: control.adapter, createFolder: async () => {}}};
	const logDir = 'logs';
	const logPath = getDailyLogFilePath(logDir);
	const block = {logDir, logPath, runId: 'fixed-run'};

	const writes = [
		startLogBlock(app, logDir, 'event=START'),
		appendLogLine(app, logDir, 'event=attempt1'),
		appendLogLine(app, logDir, 'event=attempt2'),
		endLogBlock(app, block, 'event=END'),
	];

	for (let index = 0; index < writes.length; index += 1) {
		await settleNext(control, 'read');
		assert.equal(control.active, 1);
		await settleNext(control, 'write');
	}
	await Promise.all(writes);

	assert.equal(control.maxActive, 1);
	assert.deepEqual(control.persisted.trimEnd().split('\n').map((line) => {
		const match = line.match(/event=(START|attempt1|attempt2|END)$/);
		return match?.[1];
	}), ['START', 'attempt1', 'attempt2', 'END']);
}

async function testRejectedQueuedWriteDoesNotPoisonLaterAppend() {
	let persisted = '';
	let writeCalls = 0;
	const adapter = {
		exists: async () => true,
		read: async () => persisted,
		write: async (_path, text) => {
			writeCalls += 1;
			if (writeCalls === 1) throw new Error('first write failed');
			persisted = text;
		},
	};
	const app = {vault: {adapter, createFolder: async () => {}}};

	await assert.rejects(startLogBlock(app, 'logs', 'event=START'), /first write failed/);
	await appendLogLine(app, 'logs', 'event=recovered');

	assert.equal(writeCalls, 2);
	assert.match(persisted, /event=recovered\n$/);
}

async function run(name, test) {
	await test();
	console.log(`ok - ${name}`);
}

async function main() {
	await run('log writes are serialized in public call order', testLogWritesAreSerializedInCallOrder);
	await run('a rejected queued write does not poison later appends', testRejectedQueuedWriteDoesNotPoisonLaterAppend);
	console.log('logger serialization tests passed');
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
