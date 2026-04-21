/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';
import { findFreePortFaster } from '../../../base/node/ports.js';
import { NodeSocket } from '../../../base/parts/ipc/node/ipc.net.js';
import { ISocket } from '../../../base/parts/ipc/common/ipc.net.js';
import { VSBuffer } from '../../../base/common/buffer.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import { IConnectionOptions, connectRemoteAgentTunnel } from '../../remote/common/remoteAgentConnection.js';

/**
 * SOCKS5 authentication methods (RFC 1928).
 */
const enum Socks5Auth {
	NoAuth = 0x00,
	NoAcceptable = 0xFF,
}

/**
 * SOCKS5 address types (RFC 1928).
 */
const enum Socks5Atyp {
	IPv4 = 0x01,
	DomainName = 0x03,
	IPv6 = 0x04,
}

/**
 * SOCKS5 reply codes (RFC 1928).
 */
const enum Socks5Reply {
	Succeeded = 0x00,
	GeneralFailure = 0x01,
	HostUnreachable = 0x04,
	CommandNotSupported = 0x07,
	AddressTypeNotSupported = 0x08,
}

/**
 * A SOCKS5 proxy server that routes TCP connections through the remote
 * agent tunnel.
 *
 * SOCKS5 operates at the TCP level — Chromium sends a SOCKS5 CONNECT
 * for **every** TCP connection (both HTTP and HTTPS), avoiding the
 * HTTP-vs-CONNECT split that HTTP proxies have.
 *
 * No authentication is required — security is provided by binding to
 * `127.0.0.1` with an ephemeral port (same posture as NodeRemoteTunnel).
 *
 * Binds to `127.0.0.1` only (not exposed to the network).
 */
export class TunnelProxy extends Disposable {

	private readonly _server: net.Server;
	private _localPort: number = 0;

	get localPort(): number {
		return this._localPort;
	}

	/** Proxy URL for `session.setProxy()`. */
	get proxyUrl(): string {
		return `socks5://127.0.0.1:${this._localPort}`;
	}

	constructor(
		private readonly _connectionOptions: IConnectionOptions,
		private readonly _logService: ILogService,
	) {
		super();
		this._server = net.createServer(socket => this._onConnection(socket));
		this._server.on('error', (err) => {
			this._logService.error('[TunnelProxy] Server error:', err);
		});
	}

	async start(): Promise<void> {
		const port = await findFreePortFaster(0, 2, 1000, '127.0.0.1');
		this._server.listen(port, '127.0.0.1');
		await new Promise<void>((resolve, reject) => {
			this._server.once('listening', resolve);
			this._server.once('error', reject);
		});
		const address = this._server.address() as net.AddressInfo;
		this._localPort = address.port;
		this._logService.info(`[TunnelProxy] Listening on 127.0.0.1:${this._localPort}`);
	}

	override dispose(): void {
		this._server.close();
		super.dispose();
	}

	private _onConnection(socket: net.Socket): void {
		socket.once('data', (data) => this._handleGreeting(socket, data));
	}

	/**
	 * Handle the SOCKS5 greeting (version + auth methods).
	 * We accept no-auth (0x00) — security is provided by binding to
	 * 127.0.0.1 with an ephemeral port.
	 */
	private _handleGreeting(socket: net.Socket, data: Buffer): void {
		if (data.length < 2 || data[0] !== 0x05) {
			socket.end();
			return;
		}

		const nMethods = data[1];
		const methods = data.subarray(2, 2 + nMethods);

		if (!methods.includes(Socks5Auth.NoAuth)) {
			socket.write(Buffer.from([0x05, Socks5Auth.NoAcceptable]));
			socket.end();
			return;
		}

		socket.write(Buffer.from([0x05, Socks5Auth.NoAuth]));
		socket.once('data', (reqData) => this._handleRequest(socket, reqData));
	}

	/**
	 * Handle the SOCKS5 CONNECT request (RFC 1928).
	 * Parses the target address and port, then tunnels through the remote agent.
	 */
	private _handleRequest(socket: net.Socket, data: Buffer): void {
		if (data.length < 4 || data[0] !== 0x05) {
			socket.end();
			return;
		}

		const cmd = data[1];
		if (cmd !== 0x01) {
			this._sendReply(socket, Socks5Reply.CommandNotSupported);
			socket.end();
			return;
		}

		const atyp = data[3];
		let host: string;
		let offset: number;

		switch (atyp) {
			case Socks5Atyp.IPv4: {
				if (data.length < 10) { socket.end(); return; }
				host = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`;
				offset = 8;
				break;
			}
			case Socks5Atyp.DomainName: {
				const domainLen = data[4];
				if (data.length < 5 + domainLen + 2) { socket.end(); return; }
				host = data.subarray(5, 5 + domainLen).toString('utf8');
				offset = 5 + domainLen;
				break;
			}
			case Socks5Atyp.IPv6: {
				if (data.length < 22) { socket.end(); return; }
				const parts: string[] = [];
				for (let i = 0; i < 8; i++) {
					parts.push(data.readUInt16BE(4 + i * 2).toString(16));
				}
				host = parts.join(':');
				offset = 20;
				break;
			}
			default: {
				this._sendReply(socket, Socks5Reply.AddressTypeNotSupported);
				socket.end();
				return;
			}
		}

		const port = data.readUInt16BE(offset);
		this._logService.trace(`[TunnelProxy] CONNECT ${host}:${port}`);
		this._connectTunnel(socket, host, port);
	}

	private _sendReply(socket: net.Socket, reply: number): void {
		const buf = Buffer.alloc(10);
		buf[0] = 0x05;
		buf[1] = reply;
		buf[2] = 0x00;
		buf[3] = Socks5Atyp.IPv4;
		socket.write(buf);
	}

	private async _connectTunnel(socket: net.Socket, host: string, port: number): Promise<void> {
		try {
			socket.pause();

			const protocol = await connectRemoteAgentTunnel(this._connectionOptions, host, port);
			const remoteSocket = protocol.getSocket();
			const dataChunk = protocol.readEntireBuffer();
			protocol.dispose();

			this._sendReply(socket, Socks5Reply.Succeeded);

			if (dataChunk.byteLength > 0) {
				socket.write(dataChunk.buffer);
			}

			if (remoteSocket instanceof NodeSocket) {
				this._mirrorNodeSocket(socket, remoteSocket);
			} else {
				this._mirrorGenericSocket(socket, remoteSocket);
			}
		} catch (err) {
			this._logService.error(`[TunnelProxy] Failed to tunnel to ${host}:${port}:`, err);
			this._sendReply(socket, Socks5Reply.HostUnreachable);
			socket.end();
		}
	}

	private _mirrorNodeSocket(localSocket: net.Socket, remoteNodeSocket: NodeSocket): void {
		const remoteSocket = remoteNodeSocket.socket;
		remoteSocket.on('end', () => localSocket.end());
		remoteSocket.on('close', () => localSocket.end());
		remoteSocket.on('error', () => localSocket.destroy());
		localSocket.on('end', () => remoteSocket.end());
		localSocket.on('close', () => remoteSocket.end());
		localSocket.on('error', () => remoteSocket.destroy());

		remoteSocket.pipe(localSocket);
		localSocket.pipe(remoteSocket);
	}

	private _mirrorGenericSocket(localSocket: net.Socket, remoteSocket: ISocket): void {
		remoteSocket.onClose(() => localSocket.destroy());
		remoteSocket.onEnd(() => localSocket.end());
		remoteSocket.onData(d => localSocket.write(d.buffer));
		localSocket.on('data', d => remoteSocket.write(VSBuffer.wrap(d)));
		localSocket.on('end', () => remoteSocket.end());
		localSocket.on('close', () => remoteSocket.end());
		localSocket.on('error', () => remoteSocket.end());
		localSocket.resume();
	}
}
