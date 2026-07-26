/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';

import WebSocket from 'ws';

import { test, expect } from './fixtures';
import { BrowserAgentRegistry, verifyScopedToken } from '../../packages/playwright-core/src/tools/mcp/browserAgentRegistry';
import { browserAgentPreface, encodeBrowserAgentFrame } from '../../packages/playwright-core/src/tools/mcp/browserAgentProtocol';

const scope = '11111111-1111-4111-8111-111111111111';

test('Browser Agent registry verifies scoped tokens and atomically receives desktop downloads', async ({}, testInfo) => {
  const secret = Buffer.from('registry-secret');
  const token = scopedToken(secret, scope);
  expect(verifyScopedToken(secret, token)).toBe(scope);
  expect(verifyScopedToken(Buffer.from('wrong'), token)).toBeUndefined();
  expect(verifyScopedToken(secret, 'registry-secret')).toBeUndefined();

  const port = await freePort();
  const registry = new BrowserAgentRegistry(secret);
  await registry.start('127.0.0.1', port);
  const wire = await AgentWire.connect(port, token);
  let cdp: WebSocket | undefined;
  let replacement: AgentWire | undefined;
  try {
    await wire.send({ type: 'hello', protocol: 1, agentVersion: '0.1.0' });
    expect((await wire.next('welcome')).maxFileBytes).toBe(25 * 1024 * 1024);
    await wire.send({ type: 'status', connected: true, tabCount: 3,
      agentVersion: '0.1.0', extensionVersion: '0.2.0', chromeVersion: 'Chrome/150' });
    await expect.poll(() => registry.status(scope).available).toBe(true);
    expect(registry.health()).toEqual({ connectedEnvironments: 1, availableEnvironments: 1 });
    expect(registry.status('22222222-2222-4222-8222-222222222222').available).toBe(false);
    expect(() => registry.cdpEndpoint('22222222-2222-4222-8222-222222222222')).toThrow('桌面端浏览器不可用');

    const firstEndpoint = registry.cdpEndpoint(scope);
    cdp = new WebSocket(firstEndpoint);
    await new Promise<void>((resolve, reject) => cdp!.once('open', resolve).once('error', reject));
    const opened = await wire.next('cdp_open');
    const downloadsPath = testInfo.outputPath('downloads');
    cdp.send(JSON.stringify({ id: 1, method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: downloadsPath } }));
    expect((await wire.next('cdp_message')).streamId).toBe(opened.streamId);

    const data = Buffer.from('desktop download');
    const transferId = 'transfer_1';
    const guid = 'download_guid';
    await wire.send({ type: 'download_begin', transferId, guid, size: data.length });
    await wire.send({ type: 'download_chunk', transferId, data: data.toString('base64') });
    await wire.send({ type: 'download_end', transferId,
      sha256: crypto.createHash('sha256').update(data).digest('hex') });
    expect(await wire.next('download_ack')).toMatchObject({ transferId, guid });
    expect(await fs.promises.readFile(`${downloadsPath}/${guid}`, 'utf8')).toBe('desktop download');
    expect((await fs.promises.readdir(downloadsPath)).filter(name => name.includes('.partial-'))).toEqual([]);

    replacement = await AgentWire.connect(port, token);
    await wire.closed;
    await replacement.send({ type: 'hello', protocol: 1, agentVersion: '0.1.0' });
    await replacement.next('welcome');
    await replacement.send({ type: 'status', connected: true, agentVersion: '0.1.0' });
    await expect.poll(() => registry.status(scope).available).toBe(true);
    expect(registry.cdpEndpoint(scope)).not.toBe(firstEndpoint);
  } finally {
    cdp?.close();
    replacement?.close();
    wire.close();
    await registry.close();
  }
});

class AgentWire {
  private _buffer = Buffer.alloc(0);
  private _ready = false;
  private _messages: any[] = [];
  private _waiters: Array<{ type: string, resolve: (message: any) => void }> = [];
  private _readyPromise: Promise<void>;
  private _readyCallback!: () => void;
  readonly closed: Promise<void>;

  private constructor(private readonly _socket: net.Socket) {
    this._readyPromise = new Promise(resolve => this._readyCallback = resolve);
    this.closed = new Promise(resolve => _socket.once('close', () => resolve()));
    _socket.on('data', data => this._onData(data));
  }

  static async connect(port: number, token: string): Promise<AgentWire> {
    const socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject));
    const wire = new AgentWire(socket);
    socket.write(encodeBrowserAgentFrame({ type: 'register', token }));
    await wire._readyPromise;
    return wire;
  }

  async send(message: any): Promise<void> {
    const data = encodeBrowserAgentFrame(message);
    await new Promise<void>((resolve, reject) => this._socket.write(data, error => error ? reject(error) : resolve()));
  }

  next(type: string): Promise<any> {
    const index = this._messages.findIndex(message => message.type === type);
    if (index !== -1)
      return Promise.resolve(this._messages.splice(index, 1)[0]);
    return new Promise(resolve => this._waiters.push({ type, resolve }));
  }

  close(): void {
    this._socket.destroy();
  }

  private _onData(data: Buffer): void {
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, data]) : data;
    if (!this._ready) {
      if (this._buffer.length < Buffer.byteLength(browserAgentPreface))
        return;
      expect(this._buffer.subarray(0, Buffer.byteLength(browserAgentPreface)).toString()).toBe(browserAgentPreface);
      this._buffer = this._buffer.subarray(Buffer.byteLength(browserAgentPreface));
      this._ready = true;
      this._readyCallback();
    }
    while (this._buffer.length >= 4) {
      const length = this._buffer.readUInt32BE(0);
      if (this._buffer.length < length + 4)
        return;
      const message = JSON.parse(this._buffer.subarray(4, length + 4).toString());
      this._buffer = this._buffer.subarray(length + 4);
      const waiter = this._waiters.find(candidate => candidate.type === message.type);
      if (waiter) {
        this._waiters.splice(this._waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        this._messages.push(message);
      }
    }
  }
}

function scopedToken(secret: Buffer, browserScope: string): string {
  const signature = crypto.createHmac('sha256', secret).update(`v1\n${browserScope}`).digest('base64url');
  return `v1.${browserScope}.${signature}`;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address() as net.AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
