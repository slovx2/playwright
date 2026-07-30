/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import type { BrowserId } from './routingBrowserBackend';

export type ServiceLifetime = 'task' | 'review';

export type ServiceView = {
  id: string;
  browser: BrowserId;
  targetPort: number;
  endpoint: { host: '127.0.0.1', port: number };
  lifetime: ServiceLifetime;
  expiresAt: string | null;
  activeConnections: number;
};

type OpenedService = {
  endpointPort: number;
  close: () => Promise<void>;
};

type ServiceRecord = {
  scope: string;
  browser: BrowserId;
  targetPort: number;
  id: string;
  endpointPort: number;
  taskOwners: Set<string>;
  reviewExpiresAt?: number;
  activeConnections: number;
  lastActivityAt: number;
  close: () => Promise<void>;
};

export interface DesktopServiceProvider {
  openService(scope: string, serviceId: string, targetPort: number): Promise<OpenedService>;
  closeService(scope: string, serviceId: string): Promise<void>;
  onServiceActivity(listener: (scope: string, serviceId: string, activeConnections: number) => void): () => void;
}

const reviewIdleMs = 24 * 60 * 60 * 1000;
const environmentPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class BrowserServiceManager {
  private readonly _services = new Map<string, ServiceRecord>();
  private readonly _byKey = new Map<string, string>();
  private readonly _sweepTimer: NodeJS.Timeout;
  private readonly _removeActivityListener: () => void;

  constructor(
    private readonly _workerServiceRoot: string,
    private readonly _desktop: DesktopServiceProvider,
    private readonly _now: () => number = Date.now,
  ) {
    this._removeActivityListener = _desktop.onServiceActivity((scope, id, active) => {
      const service = this._services.get(id);
      if (!service || service.scope !== scope || service.browser !== 'desktop')
        return;
      service.activeConnections = active;
      service.lastActivityAt = this._now();
      if (service.reviewExpiresAt)
        service.reviewExpiresAt = service.lastActivityAt + reviewIdleMs;
    });
    this._sweepTimer = setInterval(() => void this._sweep(), 60_000);
    this._sweepTimer.unref();
  }

  async expose(scope: string, browser: BrowserId, taskId: string | undefined,
    targetPort: number, lifetime: ServiceLifetime): Promise<ServiceView> {
    validateEnvironmentScope(scope);
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535)
      throw new Error('服务端口必须在 1 到 65535 之间');
    if (lifetime === 'task' && !taskId)
      throw new Error('当前浏览器 MCP 会话缺少任务租约 ID');
    const key = `${scope}:${browser}:${targetPort}`;
    const existingId = this._byKey.get(key);
    let service = existingId ? this._services.get(existingId) : undefined;
    if (!service) {
      const id = `service-${crypto.randomUUID()}`;
      const opened = browser === 'worker' ?
        await this._openWorker(scope, id, targetPort) :
        await this._desktop.openService(scope, id, targetPort);
      service = {
        scope, browser, targetPort, id, endpointPort: opened.endpointPort,
        taskOwners: new Set(), activeConnections: 0, lastActivityAt: this._now(),
        close: opened.close,
      };
      this._services.set(id, service);
      this._byKey.set(key, id);
    }
    if (lifetime === 'review')
      service.reviewExpiresAt = this._now() + reviewIdleMs;
    else
      service.taskOwners.add(taskId!);
    return this._view(service);
  }

  list(scope: string, browser: BrowserId): ServiceView[] {
    validateEnvironmentScope(scope);
    return [...this._services.values()]
        .filter(service => service.scope === scope && service.browser === browser)
        .map(service => this._view(service));
  }

  async close(scope: string, browser: BrowserId, id: string): Promise<void> {
    const service = this._services.get(id);
    if (!service || service.scope !== scope || service.browser !== browser)
      throw new Error('服务不存在或不属于当前环境和执行端');
    await this._remove(service);
  }

  async releaseTask(scope: string, taskId: string): Promise<void> {
    const removals: Promise<void>[] = [];
    for (const service of this._services.values()) {
      if (service.scope !== scope || !service.taskOwners.delete(taskId))
        continue;
      if (!service.taskOwners.size && !service.reviewExpiresAt)
        removals.push(this._remove(service));
    }
    await Promise.all(removals);
  }

  async closeScope(scope: string): Promise<void> {
    await Promise.all([...this._services.values()]
        .filter(service => service.scope === scope)
        .map(service => this._remove(service)));
  }

  async closeBrowserScope(scope: string, browser: BrowserId): Promise<void> {
    await Promise.all([...this._services.values()]
        .filter(service => service.scope === scope && service.browser === browser)
        .map(service => this._remove(service)));
  }

  async closeAll(): Promise<void> {
    clearInterval(this._sweepTimer);
    this._removeActivityListener();
    await Promise.all([...this._services.values()].map(service => this._remove(service)));
  }

  private async _openWorker(scope: string, id: string, targetPort: number): Promise<OpenedService> {
    const socketPath = path.join(this._workerServiceRoot, scope, 'proxy.sock');
    const info = await fs.promises.stat(socketPath).catch(() => undefined);
    if (!info?.isSocket())
      throw new Error('开发环境缺少服务代理 Socket，请重建开发环境');
    const clients = new Set<net.Socket>();
    const listener = net.createServer({ allowHalfOpen: true }, client => {
      clients.add(client);
      const service = this._services.get(id);
      if (service) {
        service.activeConnections++;
        service.lastActivityAt = this._now();
      }
      const upstream = net.createConnection({ path: socketPath, allowHalfOpen: true });
      clients.add(upstream);
      const header = Buffer.alloc(6);
      header.write('TYSP', 0, 'ascii');
      header.writeUInt16BE(targetPort, 4);
      upstream.once('connect', () => upstream.write(header));
      void readProxyStatus(upstream).then(remainder => {
        if (remainder.length)
          client.write(remainder);
        client.pipe(upstream);
        upstream.pipe(client);
      }).catch(error => client.destroy(error));
      const finish = () => {
        clients.delete(client);
        clients.delete(upstream);
        const current = this._services.get(id);
        if (current) {
          current.activeConnections = Math.max(0, current.activeConnections - 1);
          current.lastActivityAt = this._now();
          if (current.reviewExpiresAt)
            current.reviewExpiresAt = current.lastActivityAt + reviewIdleMs;
        }
      };
      client.once('close', finish);
      upstream.once('error', error => client.destroy(error));
      client.once('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve, reject) =>
      listener.listen(0, '127.0.0.1', resolve).once('error', reject));
    const address = listener.address();
    if (!address || typeof address === 'string')
      throw new Error('无法读取服务转发监听地址');
    const close = async () => {
      for (const client of clients)
        client.destroy();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    };
    const opened = { endpointPort: address.port, close };
    return opened;
  }

  private _view(service: ServiceRecord): ServiceView {
    return {
      id: service.id,
      browser: service.browser,
      targetPort: service.targetPort,
      endpoint: { host: '127.0.0.1', port: service.endpointPort },
      lifetime: service.reviewExpiresAt ? 'review' : 'task',
      expiresAt: service.reviewExpiresAt ? new Date(service.reviewExpiresAt).toISOString() : null,
      activeConnections: service.activeConnections,
    };
  }

  private async _remove(service: ServiceRecord): Promise<void> {
    if (this._services.get(service.id) !== service)
      return;
    this._services.delete(service.id);
    this._byKey.delete(`${service.scope}:${service.browser}:${service.targetPort}`);
    await service.close().catch(() => {});
  }

  private async _sweep(): Promise<void> {
    const now = this._now();
    const expired = [...this._services.values()].filter(service => {
      if (!service.reviewExpiresAt || service.activeConnections || service.reviewExpiresAt > now)
        return false;
      service.reviewExpiresAt = undefined;
      return !service.taskOwners.size;
    });
    await Promise.all(expired.map(service => this._remove(service)));
  }
}

function validateEnvironmentScope(scope: string): void {
  if (!environmentPattern.test(scope))
    throw new Error('服务转发仅支持受管开发环境');
}

async function readProxyStatus(socket: net.Socket): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('开发环境服务代理提前关闭'));
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 3)
        return;
      const length = buffered.readUInt16BE(1);
      if (buffered.length < 3 + length)
        return;
      cleanup();
      socket.pause();
      const message = buffered.subarray(3, 3 + length).toString();
      if (buffered[0] !== 0)
        reject(new Error(message || '开发环境服务代理连接失败'));
      else
        resolve(buffered.subarray(3 + length));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.resume();
  });
}
