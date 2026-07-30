/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';

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
  const versions = { bridgeVersion: '0.3.0', agentVersion: '0.2.0', extensionVersion: '0.3.0' };
  const registry = new BrowserAgentRegistry(secret, versions);
  await registry.start('127.0.0.1', port);
  const wire = await AgentWire.connect(port, token);
  let replacement: AgentWire | undefined;
  try {
    await wire.send({ type: 'hello', protocol: 2, capabilityVersion: 2,
      bridgeVersion: versions.bridgeVersion, agentVersion: versions.agentVersion,
      capabilities: ['local-tool-execution', 'cancellation', 'sessions', 'artifacts', 'service-tunnels'] });
    expect((await wire.next('welcome')).maxFileBytes).toBe(25 * 1024 * 1024);
    await wire.send({ type: 'status', connected: true, tabCount: 3,
      agentVersion: versions.agentVersion, extensionVersion: versions.extensionVersion,
      extensionProtocol: 2, chromeVersion: 'Chrome/150' });
    await expect.poll(() => registry.status(scope).available).toBe(true);
    expect(registry.health()).toEqual({ connectedEnvironments: 1, availableEnvironments: 1 });
    expect(registry.status('22222222-2222-4222-8222-222222222222').available).toBe(false);
    const serviceId = `service-${crypto.randomUUID()}`;
    const activity: number[] = [];
    const removeActivity = registry.onServiceActivity((activityScope, id, activeConnections) => {
      if (activityScope === scope && id === serviceId)
        activity.push(activeConnections);
    });
    const openedPromise = registry.openService(scope, serviceId, 8000);
    const openRequest = await wire.next('service_open');
    expect(openRequest).toMatchObject({ serviceId, targetPort: 8000 });
    await wire.send({ type: 'service_result', requestId: openRequest.requestId,
      serviceId, endpointPort: 49152 });
    const openedService = await openedPromise;
    expect(openedService.endpointPort).toBe(49152);
    await wire.send({ type: 'service_activity', serviceId, activeConnections: 1 });
    await expect.poll(() => activity).toEqual([1]);
    const closePromise = openedService.close();
    const closeRequest = await wire.next('service_close');
    await wire.send({ type: 'service_result', requestId: closeRequest.requestId, serviceId });
    await closePromise;
    removeActivity();
    const downloadsPath = testInfo.outputPath('downloads');
    expect(() => registry.createBackend('22222222-2222-4222-8222-222222222222')).toThrow('桌面端浏览器不可用');
    const backend = registry.createBackend(scope);
    await backend.initialize?.({ clientName: 'registry test', cwd: downloadsPath, scope });
    const opened = await wire.next('session_open');

    const toolResult = backend.callTool('browser_navigate', { url: 'https://example.test' }, new AbortController().signal);
    const call = await wire.next('tool_call');
    expect(call).toMatchObject({ sessionId: opened.sessionId, name: 'browser_navigate',
      arguments: { url: 'https://example.test' } });
    await wire.send({ type: 'tool_result', sessionId: call.sessionId, requestId: call.requestId,
      result: { content: [{ type: 'text', text: 'ok' }] } });
    expect(await toolResult).toMatchObject({
      content: [{ type: 'text', text: 'ok' }],
      _meta: { tyrsDesktopTiming: { bridgeRoundTripMs: expect.any(Number) } },
    });

    const controller = new AbortController();
    const cancelled = backend.callTool('browser_click', { target: 'e1' }, controller.signal);
    const cancelledCall = await wire.next('tool_call');
    controller.abort(new Error('test cancellation'));
    await expect(cancelled).rejects.toThrow('test cancellation');
    expect((await wire.next('tool_cancel')).requestId).toBe(cancelledCall.requestId);
    await wire.send({ type: 'tool_result', sessionId: cancelledCall.sessionId,
      requestId: cancelledCall.requestId, result: { content: [{ type: 'text', text: 'late' }] } });

    const data = Buffer.from('desktop download');
    const transferId = 'transfer_1';
    const guid = 'download_guid';
    await wire.send({ type: 'download_begin', sessionId: opened.sessionId, transferId, guid, size: data.length });
    await wire.send({ type: 'download_chunk', transferId, data: data.toString('base64') });
    await wire.send({ type: 'download_end', transferId,
      sha256: crypto.createHash('sha256').update(data).digest('hex') });
    expect(await wire.next('download_ack')).toMatchObject({ transferId, guid });
    expect(await fs.promises.readFile(`${downloadsPath}/${guid}`, 'utf8')).toBe('desktop download');
    expect((await fs.promises.readdir(downloadsPath)).filter(name => name.includes('.partial-'))).toEqual([]);
    await backend.dispose?.();
    expect((await wire.next('session_finalize')).sessionId).toBe(opened.sessionId);

    replacement = await AgentWire.connect(port, token);
    await wire.closed;
    await replacement.send({ type: 'hello', protocol: 2, capabilityVersion: 2,
      bridgeVersion: versions.bridgeVersion, agentVersion: versions.agentVersion,
      capabilities: ['local-tool-execution', 'cancellation', 'sessions', 'artifacts', 'service-tunnels'] });
    await replacement.next('welcome');
    await replacement.send({ type: 'status', connected: true, agentVersion: versions.agentVersion,
      extensionVersion: versions.extensionVersion, extensionProtocol: 2 });
    await expect.poll(() => registry.status(scope).available).toBe(true);
    expect(registry.createBackend(scope)).toBeTruthy();
  } finally {
    replacement?.close();
    wire.close();
    await registry.close();
  }
});

test('Browser Agent registry reassembles tool artifacts and discards late transfers', async ({}, testInfo) => {
  const secret = Buffer.from('registry-artifact-secret');
  const token = scopedToken(secret, scope);
  const port = await freePort();
  const versions = { bridgeVersion: '0.3.0', agentVersion: '0.2.0', extensionVersion: '0.3.0' };
  const registry = new BrowserAgentRegistry(secret, versions);
  await registry.start('127.0.0.1', port);
  const wire = await AgentWire.connect(port, token);
  try {
    await wire.send({ type: 'hello', protocol: 2, capabilityVersion: 2,
      bridgeVersion: versions.bridgeVersion, agentVersion: versions.agentVersion,
      capabilities: ['local-tool-execution', 'cancellation', 'sessions', 'artifacts', 'service-tunnels'] });
    await wire.next('welcome');
    await wire.send({ type: 'status', connected: true, agentVersion: versions.agentVersion,
      extensionVersion: versions.extensionVersion, extensionProtocol: 2 });
    await expect.poll(() => registry.status(scope).available).toBe(true);

    const backend = registry.createBackend(scope);
    await backend.initialize?.({ clientName: 'artifact test', cwd: testInfo.outputPath('workspace'), scope });
    const session = await wire.next('session_open');
    const resultPromise = backend.callTool('browser_snapshot', {});
    const call = await wire.next('tool_call');
    const transferId = crypto.randomUUID();
    const snapshot = Buffer.from('### Snapshot\n```yaml\n- button "Continue"\n```');
    await wire.send({ type: 'artifact_begin', sessionId: session.sessionId,
      requestId: call.requestId, transferId, contentType: 'text',
      mimeType: 'text/plain; charset=utf-8', size: snapshot.length });
    await wire.send({ type: 'artifact_chunk', transferId, data: snapshot.toString('base64') });
    await wire.send({ type: 'artifact_end', transferId,
      sha256: crypto.createHash('sha256').update(snapshot).digest('hex') });
    expect((await wire.next('artifact_ack')).transferId).toBe(transferId);
    await wire.send({ type: 'tool_result', sessionId: session.sessionId,
      requestId: call.requestId, result: { content: [{ type: 'tyrs_artifact', transferId }] } });
    expect((await resultPromise).content).toEqual([{ type: 'text', text: snapshot.toString() }]);

    const controller = new AbortController();
    const cancelled = backend.callTool('browser_snapshot', {}, controller.signal);
    const cancelledCall = await wire.next('tool_call');
    controller.abort(new Error('cancel test'));
    await expect(cancelled).rejects.toThrow('cancel test');
    await wire.next('tool_cancel');
    const lateTransferId = crypto.randomUUID();
    await wire.send({ type: 'artifact_begin', sessionId: session.sessionId,
      requestId: cancelledCall.requestId, transferId: lateTransferId, contentType: 'text',
      mimeType: 'text/plain; charset=utf-8', size: snapshot.length });
    await wire.send({ type: 'artifact_chunk', transferId: lateTransferId, data: snapshot.toString('base64') });
    await wire.send({ type: 'artifact_end', transferId: lateTransferId,
      sha256: crypto.createHash('sha256').update(snapshot).digest('hex') });
    expect((await wire.next('artifact_ack')).transferId).toBe(lateTransferId);
    expect(registry.status(scope).available).toBe(true);

    await backend.dispose?.();
  } finally {
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
