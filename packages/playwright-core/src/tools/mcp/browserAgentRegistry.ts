/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { WebSocketServer } from 'ws';
import debug from 'debug';
import { createHttpServer, startHttpServer } from '@utils/network';
import { addressToString } from '../utils/mcp/http';
import { browserAgentMaxChunkSize, browserAgentMaxFileSize, browserAgentPreface, FramedConnection } from './browserAgentProtocol';

import type { BrowserAgentMessage } from './browserAgentProtocol';
import type { WebSocket } from 'ws';

const debugLogger = debug('pw:mcp:browser-agent');
const environmentPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DownloadTransfer = {
  guid: string;
  expectedSize: number;
  chunks: Buffer[];
  size: number;
};

export type BrowserAgentStatus = {
  available: boolean;
  agentVersion?: string;
  extensionVersion?: string;
  chromeVersion?: string;
  tabCount?: number;
};

export class BrowserAgentRegistry {
  private readonly _connections = new Map<string, AgentConnection>();
  private readonly _generationListeners = new Set<(scope: string) => void>();
  private readonly _cdpServer = createHttpServer();
  private readonly _wss = new WebSocketServer({ noServer: true });
  private _agentServer?: net.Server;
  private _cdpBaseURL = '';

  constructor(private readonly _secret: Buffer) {
    this._cdpServer.on('upgrade', (request, socket, head) => {
      const match = new URL(request.url || '/', 'http://localhost').pathname.match(/^\/desktop\/([^/]+)\/([^/]+)$/);
      const connection = match ? this._connections.get(match[1]) : undefined;
      if (!connection || connection.generation !== match![2] || !connection.available()) {
        socket.destroy();
        return;
      }
      this._wss.handleUpgrade(request, socket, head, client => connection.attachCDP(client));
    });
  }

  static async startFromEnv(): Promise<BrowserAgentRegistry | undefined> {
    const secret = process.env.PLAYWRIGHT_MCP_SCOPE_SECRET;
    const port = Number(process.env.TYRS_BROWSER_AGENT_PORT || 0);
    if (!secret || !port)
      return undefined;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('invalid TYRS_BROWSER_AGENT_PORT');
    const registry = new BrowserAgentRegistry(Buffer.from(secret));
    await registry.start(process.env.TYRS_BROWSER_AGENT_HOST || '0.0.0.0', port);
    return registry;
  }

  async start(host: string, port: number): Promise<void> {
    await startHttpServer(this._cdpServer, { host: '127.0.0.1', port: 0 });
    this._cdpBaseURL = addressToString(this._cdpServer.address(), { protocol: 'ws' });
    this._agentServer = net.createServer(socket => this._accept(socket));
    await new Promise<void>((resolve, reject) => this._agentServer!.listen(port, host, resolve).once('error', reject));
  }

  status(scope: string): BrowserAgentStatus {
    return this._connections.get(scope)?.status() || { available: false };
  }

  health(): { connectedEnvironments: number, availableEnvironments: number } {
    const connections = [...this._connections.values()];
    return {
      connectedEnvironments: connections.length,
      availableEnvironments: connections.filter(connection => connection.available()).length,
    };
  }

  cdpEndpoint(scope: string): string {
    const connection = this._connections.get(scope);
    if (!connection?.available())
      throw new Error('桌面端浏览器不可用');
    return `${this._cdpBaseURL}/desktop/${scope}/${connection.generation}`;
  }

  onGenerationChanged(listener: (scope: string) => void): () => void {
    this._generationListeners.add(listener);
    return () => this._generationListeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const connection of this._connections.values())
      connection.close();
    this._connections.clear();
    await Promise.all([
      new Promise<void>(resolve => this._cdpServer.close(() => resolve())),
      new Promise<void>(resolve => this._agentServer?.close(() => resolve()) || resolve()),
    ]);
  }

  private _accept(socket: net.Socket): void {
    const framed = new FramedConnection(socket);
    const registrationTimer = setTimeout(() => framed.close(), 15_000);
    framed.once('close', () => clearTimeout(registrationTimer));
    const onFirstMessage = (message: BrowserAgentMessage) => {
      clearTimeout(registrationTimer);
      framed.off('message', onFirstMessage);
      if (message.type !== 'register' || typeof message.token !== 'string') {
        framed.close();
        return;
      }
      const scope = verifyScopedToken(this._secret, message.token);
      if (!scope || scope === 'worker') {
        framed.close();
        return;
      }
      const connection = new AgentConnection(scope, framed, () => this._connectionChanged(scope, connection));
      this._connections.get(scope)?.close();
      this._connections.set(scope, connection);
      socket.write(browserAgentPreface);
      connection.start();
      this._notifyGeneration(scope);
    };
    framed.on('message', onFirstMessage);
  }

  private _connectionChanged(scope: string, connection: AgentConnection): void {
    if (this._connections.get(scope) !== connection)
      return;
    if (connection.closed()) {
      this._connections.delete(scope);
      this._notifyGeneration(scope);
    }
  }

  private _notifyGeneration(scope: string): void {
    for (const listener of this._generationListeners)
      listener(scope);
  }
}

class AgentConnection {
  readonly generation = crypto.randomUUID();
  private _status: BrowserAgentStatus = { available: false };
  private _cdp?: WebSocket;
  private _downloadsPath = '';
  private _transfers = new Map<string, DownloadTransfer>();
  private _closed = false;
  private _welcomed = false;
  private _lastSeen = Date.now();
  private _heartbeat?: NodeJS.Timeout;
  private _messageChain = Promise.resolve();

  constructor(readonly scope: string, private readonly _framed: FramedConnection, private readonly _onChange: () => void) {}

  start(): void {
    this._framed.on('message', message => {
      this._messageChain = this._messageChain.then(() => this._onMessage(message)).catch(error => {
        debugLogger(error);
        // eslint-disable-next-line no-console
        console.error(`[browser-agent:${this.scope}] ${error instanceof Error ? error.stack || error.message : String(error)}`);
        void this._framed.send({ type: 'error', message: error instanceof Error ? error.message : String(error) }).catch(() => {});
        this.close();
      });
    });
    this._framed.on('close', () => this.close());
    this._framed.on('connectionerror', error => debugLogger(error));
    this._heartbeat = setInterval(() => {
      if (Date.now() - this._lastSeen > 45_000)
        return this.close();
      void this._framed.send({ type: 'ping', at: Date.now() }).catch(() => this.close());
    }, 15_000);
  }

  available(): boolean {
    return !this._closed && this._status.available;
  }

  status(): BrowserAgentStatus {
    return { ...this._status, available: this.available() };
  }

  closed(): boolean {
    return this._closed;
  }

  attachCDP(client: WebSocket): void {
    if (this._cdp) {
      client.close(1013, 'Another CDP connection is active');
      return;
    }
    this._cdp = client;
    const streamId = crypto.randomUUID();
    void this._framed.send({ type: 'cdp_open', streamId });
    client.on('message', data => {
      const message = data.toString();
      this._captureDownloadPath(message);
      void this._framed.send({ type: 'cdp_message', streamId, message }).catch(() => client.close());
    });
    client.on('close', () => {
      if (this._cdp === client)
        this._cdp = undefined;
      void this._framed.send({ type: 'cdp_close', streamId }).catch(() => {});
    });
  }

  close(): void {
    if (this._closed)
      return;
    this._closed = true;
    if (this._heartbeat)
      clearInterval(this._heartbeat);
    this._cdp?.close(1011, 'Browser Agent disconnected');
    this._framed.close();
    this._onChange();
  }

  private async _onMessage(message: BrowserAgentMessage): Promise<void> {
    this._lastSeen = Date.now();
    switch (message.type) {
      case 'hello':
        if (this._welcomed || message.protocol !== 1)
          throw new Error('Incompatible Browser Agent protocol');
        this._welcomed = true;
        await this._framed.send({ type: 'welcome', protocol: 1, maxFileBytes: browserAgentMaxFileSize, heartbeatIntervalMs: 15_000 });
        break;
      case 'status':
        if (!this._welcomed)
          throw new Error('Browser Agent status arrived before hello');
        this._status = { available: message.connected === true, agentVersion: String(message.agentVersion || ''), extensionVersion: String(message.extensionVersion || ''), chromeVersion: String(message.chromeVersion || ''), tabCount: Number(message.tabCount || 0) };
        this._onChange();
        break;
      case 'ping':
        await this._framed.send({ type: 'pong', at: message.at });
        break;
      case 'pong':
        break;
      case 'cdp_message':
        this._cdp?.send(String(message.message || ''));
        break;
      case 'cdp_close':
        this._cdp?.close(1000, 'Remote CDP closed');
        break;
      case 'download_begin':
        this._beginDownload(message);
        break;
      case 'download_chunk':
        this._appendDownload(message);
        break;
      case 'download_end':
        await this._finishDownload(message);
        break;
      case 'error':
        if (typeof message.transferId === 'string')
          this._transfers.delete(message.transferId);
        debugLogger(`Browser Agent error: ${String(message.message || '')}`);
        break;
    }
  }

  private _captureDownloadPath(message: string): void {
    try {
      const command = JSON.parse(message);
      if (command.method === 'Browser.setDownloadBehavior' && typeof command.params?.downloadPath === 'string')
        this._downloadsPath = command.params.downloadPath;
    } catch {
    }
  }

  private _beginDownload(message: BrowserAgentMessage): void {
    const expectedSize = Number(message.size);
    const guid = String(message.guid || '');
    const transferId = String(message.transferId || '');
    if (!/^[a-zA-Z0-9_-]+$/.test(guid) || !/^[a-zA-Z0-9_-]+$/.test(transferId) ||
        this._transfers.has(transferId) || !Number.isInteger(expectedSize) || expectedSize < 0 || expectedSize > browserAgentMaxFileSize)
      throw new Error('Invalid Browser Agent download metadata');
    this._transfers.set(transferId, { guid, expectedSize, chunks: [], size: 0 });
  }

  private _appendDownload(message: BrowserAgentMessage): void {
    const transfer = this._transfers.get(String(message.transferId || ''));
    if (!transfer)
      throw new Error('Unknown Browser Agent download transfer');
    const encoded = String(message.data || '');
    const chunk = Buffer.from(encoded, 'base64');
    if (!encoded || chunk.toString('base64') !== encoded || chunk.length > browserAgentMaxChunkSize ||
        transfer.size + chunk.length > transfer.expectedSize)
      throw new Error('Invalid Browser Agent download chunk');
    transfer.chunks.push(chunk);
    transfer.size += chunk.length;
  }

  private async _finishDownload(message: BrowserAgentMessage): Promise<void> {
    const transferId = String(message.transferId || '');
    const transfer = this._transfers.get(transferId);
    this._transfers.delete(transferId);
    const expectedDigest = String(message.sha256 || '');
    if (!transfer || transfer.size !== transfer.expectedSize || !this._downloadsPath ||
        !/^[a-f0-9]{64}$/.test(expectedDigest))
      throw new Error('Incomplete Browser Agent download');
    const data = Buffer.concat(transfer.chunks);
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    if (digest !== expectedDigest)
      throw new Error('Browser Agent download checksum mismatch');
    await fs.promises.mkdir(this._downloadsPath, { recursive: true });
    const temporary = path.join(this._downloadsPath, `.${transfer.guid}.partial-${transferId}`);
    const target = path.join(this._downloadsPath, transfer.guid);
    try {
      await fs.promises.writeFile(temporary, data, { mode: 0o600 });
      await fs.promises.rename(temporary, target);
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
    await this._framed.send({ type: 'download_ack', transferId, guid: transfer.guid });
  }
}

export function verifyScopedToken(secret: Buffer, token: string): string | undefined {
  const match = token.match(/^v1\.(worker|[0-9a-f-]+)\.([A-Za-z0-9_-]+)$/);
  if (!match || (match[1] !== 'worker' && !environmentPattern.test(match[1])))
    return undefined;
  const expected = crypto.createHmac('sha256', secret).update(`v1\n${match[1].toLowerCase()}`).digest('base64url');
  const actual = Buffer.from(match[2]);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && crypto.timingSafeEqual(actual, wanted) ? match[1].toLowerCase() : undefined;
}
