/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import { test, expect } from './fixtures';
import { BrowserServiceManager } from '../../packages/playwright-core/src/tools/backend/browserServiceManager';

import fs from 'fs';
import net from 'net';
import path from 'path';

import type { DesktopServiceProvider } from '../../packages/playwright-core/src/tools/backend/browserServiceManager';

const scope = '11111111-1111-4111-8111-111111111111';

test('service manager reuses endpoints and tracks task/review leases', async () => {
  const desktop = new FakeDesktopServices();
  const manager = new BrowserServiceManager('/unused', desktop);
  try {
    const first = await manager.expose(scope, 'desktop',
        '22222222-2222-4222-8222-222222222222', 8000, 'task');
    const second = await manager.expose(scope, 'desktop',
        '33333333-3333-4333-8333-333333333333', 8000, 'task');
    expect(second.id).toBe(first.id);
    expect(second.endpoint).toEqual(first.endpoint);

    await manager.releaseTask(scope, '22222222-2222-4222-8222-222222222222');
    expect(manager.list(scope, 'desktop')).toHaveLength(1);
    const review = await manager.expose(scope, 'desktop',
        '33333333-3333-4333-8333-333333333333', 8000, 'review');
    expect(review.id).toBe(first.id);
    expect(review.lifetime).toBe('review');
    expect(review.expiresAt).not.toBeNull();
    await manager.releaseTask(scope, '33333333-3333-4333-8333-333333333333');
    expect(manager.list(scope, 'desktop')).toHaveLength(1);

    desktop.activity(scope, first.id, 2);
    expect(manager.list(scope, 'desktop')[0].activeConnections).toBe(2);
    await manager.close(scope, 'desktop', first.id);
    expect(manager.list(scope, 'desktop')).toEqual([]);
    expect(desktop.closed).toEqual([first.id]);
  } finally {
    await manager.closeAll();
  }
});

test('service manager rejects worker scope and cross-browser close', async () => {
  const desktop = new FakeDesktopServices();
  const manager = new BrowserServiceManager('/unused', desktop);
  try {
    await expect(manager.expose('worker', 'desktop', undefined, 8000, 'review'))
        .rejects.toThrow('受管开发环境');
    const service = await manager.expose(scope, 'desktop',
        '22222222-2222-4222-8222-222222222222', 8000, 'task');
    await expect(manager.close(scope, 'worker', service.id))
        .rejects.toThrow('不属于当前环境和执行端');
  } finally {
    await manager.closeAll();
  }
});

test('worker service transparently relays TCP through the environment Unix socket', async () => {
  const root = await fs.promises.mkdtemp('/tmp/pw-service-');
  const directory = path.join(root, scope);
  await fs.promises.mkdir(directory);
  const socketPath = path.join(directory, 'proxy.sock');
  const proxy = net.createServer({ allowHalfOpen: true }, socket => {
    socket.once('data', header => {
      expect(header.subarray(0, 4).toString()).toBe('TYSP');
      expect(header.readUInt16BE(4)).toBe(43210);
      socket.write(Buffer.from([0, 0, 0]));
      socket.on('data', data => socket.write(data));
      socket.on('end', () => socket.end());
    });
  });
  await new Promise<void>((resolve, reject) =>
    proxy.listen(socketPath, resolve).once('error', reject));
  const manager = new BrowserServiceManager(root, new FakeDesktopServices());
  try {
    const service = await manager.expose(scope, 'worker',
        '22222222-2222-4222-8222-222222222222', 43210, 'task');
    const response = await new Promise<string>((resolve, reject) => {
      const client = net.connect(service.endpoint.port, service.endpoint.host);
      let value = '';
      client.setEncoding('utf8');
      client.on('data', data => value += data);
      client.once('end', () => resolve(value));
      client.once('error', reject);
      client.once('connect', () => client.end('transparent-tcp'));
    });
    expect(response).toBe('transparent-tcp');
    await expect.poll(() => manager.list(scope, 'worker')[0].activeConnections).toBe(0);
  } finally {
    await manager.closeAll();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});

test('review expiry downgrades to remaining task lease and then removes the service', async () => {
  let now = 1_000;
  const manager = new BrowserServiceManager('/unused', new FakeDesktopServices(), () => now);
  const sweep = () => (manager as unknown as { _sweep(): Promise<void> })._sweep();
  try {
    const taskId = '22222222-2222-4222-8222-222222222222';
    const service = await manager.expose(scope, 'desktop', taskId, 8000, 'task');
    await manager.expose(scope, 'desktop', taskId, 8000, 'review');
    now += 24 * 60 * 60 * 1000 + 1;
    await sweep();
    expect(manager.list(scope, 'desktop')).toEqual([
      expect.objectContaining({ id: service.id, lifetime: 'task', expiresAt: null }),
    ]);
    await manager.releaseTask(scope, taskId);
    expect(manager.list(scope, 'desktop')).toEqual([]);

    await manager.expose(scope, 'desktop', undefined, 8001, 'review');
    now += 24 * 60 * 60 * 1000 + 1;
    await sweep();
    expect(manager.list(scope, 'desktop')).toEqual([]);
  } finally {
    await manager.closeAll();
  }
});

class FakeDesktopServices implements DesktopServiceProvider {
  private _listeners = new Set<(scope: string, serviceId: string, activeConnections: number) => void>();
  readonly closed: string[] = [];
  private _nextPort = 49152;

  async openService(serviceScope: string, serviceId: string, _targetPort: number) {
    return { endpointPort: this._nextPort++,
      close: () => this.closeService(serviceScope, serviceId) };
  }

  async closeService(_scope: string, serviceId: string): Promise<void> {
    this.closed.push(serviceId);
  }

  onServiceActivity(listener: (scope: string, serviceId: string, activeConnections: number) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  activity(activityScope: string, serviceId: string, activeConnections: number): void {
    for (const listener of this._listeners)
      listener(activityScope, serviceId, activeConnections);
  }
}
