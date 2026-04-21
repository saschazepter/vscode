/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as net from 'net';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { TunnelProxy } from '../../node/tunnelProxy.js';
import { IConnectionOptions } from '../../../remote/common/remoteAgentConnection.js';
import { NullLogService } from '../../../log/common/log.js';

function buildConnectIPv4(host: string, port: number): Buffer {
	const parts = host.split('.').map(Number);
	const buf = Buffer.alloc(10);
	buf[0] = 0x05; buf[1] = 0x01; buf[2] = 0x00; buf[3] = 0x01;
	buf[4] = parts[0]; buf[5] = parts[1]; buf[6] = parts[2]; buf[7] = parts[3];
	buf.writeUInt16BE(port, 8);
	return buf;
}

function buildConnectDomain(domain: string, port: number): Buffer {
	const d = Buffer.from(domain, 'utf8');
	const buf = Buffer.alloc(4 + 1 + d.length + 2);
	buf[0] = 0x05; buf[1] = 0x01; buf[2] = 0x00; buf[3] = 0x03;
	buf[4] = d.length;
	d.copy(buf, 5);
	buf.writeUInt16BE(port, 5 + d.length);
	return buf;
}

function buildConnectIPv6(parts: number[], port: number): Buffer {
	const buf = Buffer.alloc(4 + 16 + 2);
	buf[0] = 0x05; buf[1] = 0x01; buf[2] = 0x00; buf[3] = 0x04;
	for (let i = 0; i < 8; i++) { buf.writeUInt16BE(parts[i], 4 + i * 2); }
	buf.writeUInt16BE(port, 20);
	return buf;
}

function readBytes(socket: net.Socket, n: number, timeoutMs = 2000): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let received = 0;
		const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out (got ${received}/${n})`)); }, timeoutMs);
		function onData(data: Buffer) { chunks.push(data); received += data.length; if (received >= n) { cleanup(); resolve(Buffer.concat(chunks).subarray(0, n)); } }
		function onClose() { cleanup(); reject(new Error(`Closed after ${received}/${n}`)); }
		function cleanup() { clearTimeout(timeout); socket.removeListener('data', onData); socket.removeListener('close', onClose); }
		socket.on('data', onData); socket.on('close', onClose);
	});
}

function connectToProxy(port: number): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.removeListener('error', reject); resolve(s); });
		s.once('error', reject);
	});
}

async function doGreeting(socket: net.Socket): Promise<Buffer> {
	socket.write(Buffer.from([0x05, 0x01, 0x00]));
	return readBytes(socket, 2);
}

const dummyOpts: IConnectionOptions = {
	commit: undefined,
	quality: undefined,
	addressProvider: { getAddress: () => Promise.reject(new Error('no remote')) },
	remoteSocketFactoryService: { _serviceBrand: undefined, register: () => ({ dispose: () => { } }), connect: () => Promise.reject(new Error('no factory')) },
	signService: { _serviceBrand: undefined, createNewMessage: () => Promise.resolve({ id: '', data: '' }), validate: () => Promise.resolve(true), sign: () => Promise.resolve('') },
	logService: new NullLogService(),
	ipcLogger: null,
};

suite('TunnelProxy', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let proxy: TunnelProxy;

	setup(async () => {
		proxy = new TunnelProxy(dummyOpts, new NullLogService());
		store.add(proxy);
		await proxy.start();
	});

	// --- Greeting ---

	test('rejects non-SOCKS5', async () => {
		const s = await connectToProxy(proxy.localPort);
		s.write(Buffer.from([0x04, 0x01, 0x00]));
		await new Promise<void>(r => s.on('close', r));
		s.destroy();
	});

	test('rejects greeting with only auth methods', async () => {
		const s = await connectToProxy(proxy.localPort);
		s.write(Buffer.from([0x05, 0x01, 0x02]));
		const resp = await readBytes(s, 2);
		assert.strictEqual(resp[1], 0xFF);
		s.destroy();
	});

	test('selects no-auth', async () => {
		const s = await connectToProxy(proxy.localPort);
		const resp = await doGreeting(s);
		assert.strictEqual(resp[0], 0x05);
		assert.strictEqual(resp[1], 0x00);
		s.destroy();
	});

	// --- CONNECT (tunnel fails → 0x04 HostUnreachable) ---

	test('CONNECT IPv4', async () => {
		const s = await connectToProxy(proxy.localPort);
		await doGreeting(s);
		s.write(buildConnectIPv4('192.168.1.1', 8080));
		const resp = await readBytes(s, 10);
		assert.strictEqual(resp[0], 0x05);
		assert.strictEqual(resp[1], 0x04);
		s.destroy();
	});

	test('CONNECT domain', async () => {
		const s = await connectToProxy(proxy.localPort);
		await doGreeting(s);
		s.write(buildConnectDomain('example.com', 443));
		const resp = await readBytes(s, 10);
		assert.strictEqual(resp[1], 0x04);
		s.destroy();
	});

	test('CONNECT IPv6', async () => {
		const s = await connectToProxy(proxy.localPort);
		await doGreeting(s);
		s.write(buildConnectIPv6([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1], 80));
		const resp = await readBytes(s, 10);
		assert.strictEqual(resp[1], 0x04);
		s.destroy();
	});

	test('rejects BIND command', async () => {
		const s = await connectToProxy(proxy.localPort);
		await doGreeting(s);
		const req = buildConnectIPv4('127.0.0.1', 80);
		req[1] = 0x02;
		s.write(req);
		const resp = await readBytes(s, 10);
		assert.strictEqual(resp[1], 0x07);
		s.destroy();
	});

	test('rejects unsupported address type', async () => {
		const s = await connectToProxy(proxy.localPort);
		await doGreeting(s);
		s.write(Buffer.from([0x05, 0x01, 0x00, 0x05, 0x00, 0x00]));
		const resp = await readBytes(s, 10);
		assert.strictEqual(resp[1], 0x08);
		s.destroy();
	});

	// --- Lifecycle ---

	test('proxyUrl is socks5 on loopback', () => {
		assert.ok(proxy.localPort > 0);
		assert.strictEqual(proxy.proxyUrl, `socks5://127.0.0.1:${proxy.localPort}`);
	});

	test('concurrent connections', async () => {
		const sockets = await Promise.all([connectToProxy(proxy.localPort), connectToProxy(proxy.localPort), connectToProxy(proxy.localPort)]);
		for (const s of sockets) {
			const resp = await doGreeting(s);
			assert.strictEqual(resp[1], 0x00);
		}
		for (const s of sockets) { s.destroy(); }
	});
});
