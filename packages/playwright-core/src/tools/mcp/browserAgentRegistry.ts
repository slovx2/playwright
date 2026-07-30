/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import path from 'path';

import debug from 'debug';
import { browserAgentCapabilityVersion, browserAgentMaxChunkSize, browserAgentMaxFileSize, browserAgentPreface, browserAgentProtocolVersion, FramedConnection } from './browserAgentProtocol';

import type { BrowserAgentMessage } from './browserAgentProtocol';
import type * as mcpServer from '../utils/mcp/server';
import type { ClientInfo, ServerBackend } from '../utils/mcp/server';
import type { DesktopServiceProvider } from '../backend/browserServiceManager';

const debugLogger = debug('pw:mcp:browser-agent');
const environmentPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type DownloadTransfer = {
  sessionId: string;
  guid: string;
  expectedSize: number;
  chunks: Buffer[];
  size: number;
};

type ToolArtifactTransfer = {
  sessionId: string;
  requestId: string;
  contentType: 'text' | 'image';
  mimeType: string;
  expectedSize: number;
  chunks: Buffer[];
  size: number;
  discard: boolean;
};

type CompletedToolArtifact = {
  sessionId: string;
  requestId: string;
  content: { type: 'text', text: string } | { type: 'image', data: string, mimeType: string };
};

type PendingCall = {
  sessionId: string;
  resolve: (result: mcpServer.CallToolResult & { isClose?: boolean }) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  startedAt: number;
  signal?: AbortSignal;
  onAbort?: () => void;
};

export type BrowserAgentStatus = {
  available: boolean;
  reason?: string;
  agentVersion?: string;
  extensionVersion?: string;
  chromeVersion?: string;
  tabCount?: number;
};

export class BrowserAgentRegistry implements DesktopServiceProvider {
  private readonly _connections = new Map<string, AgentConnection>();
  private readonly _generationListeners = new Set<(scope: string) => void>();
  private readonly _serviceActivityListeners = new Set<(scope: string, serviceId: string, activeConnections: number) => void>();
  private _agentServer?: net.Server;

  constructor(
    private readonly _secret: Buffer,
    private readonly _versions: { bridgeVersion: string, agentVersion: string, extensionVersion: string },
  ) {}

  static async startFromEnv(): Promise<BrowserAgentRegistry | undefined> {
    const secret = process.env.PLAYWRIGHT_MCP_SCOPE_SECRET;
    const port = Number(process.env.TYRS_BROWSER_AGENT_PORT || 0);
    if (!secret || !port)
      return undefined;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error('invalid TYRS_BROWSER_AGENT_PORT');
    const registry = new BrowserAgentRegistry(Buffer.from(secret), {
      bridgeVersion: requiredVersion(process.env.TYRS_BROWSER_BRIDGE_VERSION, 'bridge'),
      agentVersion: requiredVersion(process.env.TYRS_BROWSER_REQUIRED_AGENT_VERSION, 'Browser Agent'),
      extensionVersion: requiredVersion(process.env.TYRS_BROWSER_REQUIRED_EXTENSION_VERSION, 'extension'),
    });
    await registry.start(process.env.TYRS_BROWSER_AGENT_HOST || '0.0.0.0', port);
    return registry;
  }

  async start(host: string, port: number): Promise<void> {
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

  createBackend(scope: string): ServerBackend {
    const connection = this._connections.get(scope);
    if (!connection?.available())
      throw new Error('桌面端浏览器不可用');
    return new RemoteBrowserBackend(connection);
  }

  async openService(scope: string, serviceId: string, targetPort: number): Promise<{ endpointPort: number, close: () => Promise<void> }> {
    const connection = this._connections.get(scope);
    if (!connection?.available())
      throw new Error('桌面端浏览器不可用');
    const endpointPort = await connection.openService(serviceId, targetPort);
    return { endpointPort, close: () => this.closeService(scope, serviceId) };
  }

  async closeService(scope: string, serviceId: string): Promise<void> {
    await this._connections.get(scope)?.closeService(serviceId);
  }

  onServiceActivity(listener: (scope: string, serviceId: string, activeConnections: number) => void): () => void {
    this._serviceActivityListeners.add(listener);
    return () => this._serviceActivityListeners.delete(listener);
  }

  onGenerationChanged(listener: (scope: string) => void): () => void {
    this._generationListeners.add(listener);
    return () => this._generationListeners.delete(listener);
  }

  async close(): Promise<void> {
    for (const connection of this._connections.values())
      connection.close();
    this._connections.clear();
    await new Promise<void>(resolve => this._agentServer?.close(() => resolve()) || resolve());
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
      const connection = new AgentConnection(
          scope,
          framed,
          this._versions,
          () => this._connectionChanged(scope, connection),
          (serviceId, activeConnections) => {
            for (const listener of this._serviceActivityListeners)
              listener(scope, serviceId, activeConnections);
          });
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
  private _transfers = new Map<string, DownloadTransfer>();
  private _artifactTransfers = new Map<string, ToolArtifactTransfer>();
  private _completedArtifacts = new Map<string, CompletedToolArtifact>();
  private _pendingCalls = new Map<string, PendingCall>();
  private _pendingServiceRequests = new Map<string, {
    resolve: (message: BrowserAgentMessage) => void,
    reject: (error: Error) => void,
    timer: NodeJS.Timeout,
  }>();
  private _sessionWorkspaces = new Map<string, string>();
  private _closed = false;
  private _welcomed = false;
  private _agentVersion = '';
  private _lastSeen = Date.now();
  private _heartbeat?: NodeJS.Timeout;
  private _messageChain = Promise.resolve();

  constructor(
    readonly scope: string,
    private readonly _framed: FramedConnection,
    private readonly _versions: { bridgeVersion: string, agentVersion: string, extensionVersion: string },
    private readonly _onChange: () => void,
    private readonly _onServiceActivity: (serviceId: string, activeConnections: number) => void,
  ) {}

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

  async openSession(sessionId: string, clientInfo: ClientInfo): Promise<void> {
    this._sessionWorkspaces.set(sessionId, clientInfo.cwd);
    await this._framed.send({
      type: 'session_open',
      sessionId,
      generation: this.generation,
      clientName: clientInfo.clientName,
      cwd: clientInfo.cwd,
    });
  }

  async finalizeSession(sessionId: string): Promise<void> {
    this._sessionWorkspaces.delete(sessionId);
    await this._framed.send({ type: 'session_finalize', sessionId, generation: this.generation }).catch(() => {});
  }

  async callTool(sessionId: string, name: string, args: mcpServer.CallToolRequest['params']['arguments'], signal?: AbortSignal): Promise<mcpServer.CallToolResult & { isClose?: boolean }> {
    if (this._closed || !this.available())
      throw new Error('桌面端浏览器不可用');
    const requestId = crypto.randomUUID();
    const timeoutMs = name === 'browser_batch' ? 125_000 : 65_000;
    return await new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        const current = this._pendingCalls.get(requestId);
        this._pendingCalls.delete(requestId);
        this._dropToolArtifacts(requestId);
        if (current?.signal && current.onAbort)
          current.signal.removeEventListener('abort', current.onAbort);
        void this._framed.send({ type: 'tool_cancel', sessionId, requestId, reason: 'deadline' }).catch(() => {});
        reject(new Error('Desktop browser tool timed out'));
      }, timeoutMs);
      const pending: PendingCall = { sessionId, resolve, reject, timer, signal, startedAt: performance.now() };
      this._pendingCalls.set(requestId, pending);
      const onAbort = () => {
        if (this._pendingCalls.delete(requestId)) {
          clearTimeout(timer);
          this._dropToolArtifacts(requestId);
          signal?.removeEventListener('abort', onAbort);
          void this._framed.send({ type: 'tool_cancel', sessionId, requestId, reason: 'cancelled' }).catch(() => {});
          reject(signal?.reason instanceof Error ? signal.reason : new Error('Desktop browser tool was cancelled'));
        }
      };
      pending.onAbort = onAbort;
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        await this._framed.send({
          type: 'tool_call',
          sessionId,
          requestId,
          generation: this.generation,
          deadlineMs: Date.now() + timeoutMs,
          name,
          arguments: args ?? {},
        });
      } catch (error) {
        if (this._pendingCalls.delete(requestId)) {
          clearTimeout(timer);
          this._dropToolArtifacts(requestId);
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        }
      }
    });
  }

  async openService(serviceId: string, targetPort: number): Promise<number> {
    const response = await this._serviceRequest('service_open', { serviceId, targetPort });
    const endpointPort = Number(response.endpointPort);
    if (!Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65535)
      throw new Error('Browser Agent 返回了无效的服务端口');
    return endpointPort;
  }

  async closeService(serviceId: string): Promise<void> {
    if (this._closed)
      return;
    await this._serviceRequest('service_close', { serviceId });
  }

  close(): void {
    if (this._closed)
      return;
    this._closed = true;
    if (this._heartbeat)
      clearInterval(this._heartbeat);
    for (const pending of this._pendingCalls.values()) {
      clearTimeout(pending.timer);
      if (pending.signal && pending.onAbort)
        pending.signal.removeEventListener('abort', pending.onAbort);
      pending.reject(new Error('Browser Agent disconnected'));
    }
    this._pendingCalls.clear();
    for (const pending of this._pendingServiceRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Browser Agent disconnected'));
    }
    this._pendingServiceRequests.clear();
    this._artifactTransfers.clear();
    this._completedArtifacts.clear();
    this._framed.close();
    this._onChange();
  }

  private async _onMessage(message: BrowserAgentMessage): Promise<void> {
    this._lastSeen = Date.now();
    switch (message.type) {
      case 'hello':
        if (this._welcomed || message.protocol !== browserAgentProtocolVersion ||
            message.capabilityVersion !== browserAgentCapabilityVersion ||
            message.bridgeVersion !== this._versions.bridgeVersion ||
            !Array.isArray(message.capabilities) ||
            !['local-tool-execution', 'cancellation', 'sessions', 'artifacts', 'service-tunnels'].every(value => message.capabilities.includes(value)) ||
            String(message.agentVersion || '') !== this._versions.agentVersion)
          throw new Error('Incompatible Browser Agent protocol');
        this._welcomed = true;
        this._agentVersion = String(message.agentVersion);
        await this._framed.send({ type: 'welcome', protocol: browserAgentProtocolVersion,
          capabilityVersion: browserAgentCapabilityVersion, generation: this.generation,
          bridgeVersion: this._versions.bridgeVersion,
          capabilities: ['local-tool-execution', 'cancellation', 'sessions', 'artifacts', 'service-tunnels'],
          maxFileBytes: browserAgentMaxFileSize, heartbeatIntervalMs: 15_000 });
        await this._framed.send({ type: 'service_reset', generation: this.generation });
        break;
      case 'status':
        if (!this._welcomed)
          throw new Error('Browser Agent status arrived before hello');
        if (String(message.agentVersion || '') !== this._agentVersion ||
            (message.connected === true &&
              (Number(message.extensionProtocol) !== browserAgentProtocolVersion ||
               String(message.extensionVersion || '') !== this._versions.extensionVersion)))
          throw new Error('Browser Agent component versions are incompatible');
        this._status = { available: message.connected === true, reason: String(message.reason || '') || undefined,
          agentVersion: this._agentVersion, extensionVersion: String(message.extensionVersion || ''),
          chromeVersion: String(message.chromeVersion || ''), tabCount: Number(message.tabCount || 0) };
        this._onChange();
        break;
      case 'ping':
        await this._framed.send({ type: 'pong', at: message.at });
        break;
      case 'pong':
        break;
      case 'tool_result':
        this._finishToolCall(message);
        break;
      case 'artifact_begin':
        this._beginToolArtifact(message);
        break;
      case 'artifact_chunk':
        this._appendToolArtifact(message);
        break;
      case 'artifact_end':
        await this._finishToolArtifact(message);
        break;
      case 'session_interrupted':
        this._interruptSession(String(message.sessionId || ''), String(message.reason || 'Browser control was interrupted'));
        break;
      case 'service_result':
        this._finishServiceRequest(message);
        break;
      case 'service_activity':
        this._onServiceActivity(String(message.serviceId || ''), Number(message.activeConnections || 0));
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

  private async _serviceRequest(type: string, fields: Record<string, unknown>): Promise<BrowserAgentMessage> {
    if (this._closed || !this.available())
      throw new Error('桌面端浏览器不可用');
    const requestId = crypto.randomUUID();
    return await new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingServiceRequests.delete(requestId);
        reject(new Error('Desktop service request timed out'));
      }, 15_000);
      this._pendingServiceRequests.set(requestId, { resolve, reject, timer });
      try {
        await this._framed.send({ type, requestId, generation: this.generation, ...fields });
      } catch (error) {
        const pending = this._pendingServiceRequests.get(requestId);
        if (pending) {
          this._pendingServiceRequests.delete(requestId);
          clearTimeout(timer);
          reject(error);
        }
      }
    });
  }

  private _finishServiceRequest(message: BrowserAgentMessage): void {
    const requestId = String(message.requestId || '');
    const pending = this._pendingServiceRequests.get(requestId);
    if (!pending)
      return;
    this._pendingServiceRequests.delete(requestId);
    clearTimeout(pending.timer);
    if (message.error)
      pending.reject(new Error(String(message.error)));
    else
      pending.resolve(message);
  }

  private _finishToolCall(message: BrowserAgentMessage): void {
    const requestId = String(message.requestId || '');
    const pending = this._pendingCalls.get(requestId);
    if (!pending || pending.sessionId !== String(message.sessionId || ''))
      return;
    this._pendingCalls.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort)
      pending.signal.removeEventListener('abort', pending.onAbort);
    const result = message.result;
    if (!result || !Array.isArray(result.content)) {
      this._dropToolArtifacts(requestId);
      pending.reject(new Error('Browser Agent returned an invalid tool result'));
      return;
    }
    const content: any[] = [];
    for (const item of result.content) {
      if (item?.type !== 'tyrs_artifact') {
        content.push(item);
        continue;
      }
      const transferId = String(item.transferId || '');
      const artifact = this._completedArtifacts.get(transferId);
      if (!artifact || artifact.sessionId !== pending.sessionId || artifact.requestId !== requestId) {
        this._dropToolArtifacts(requestId);
        pending.reject(new Error('Browser Agent returned an unresolved tool artifact'));
        return;
      }
      this._completedArtifacts.delete(transferId);
      content.push(artifact.content);
    }
    this._dropToolArtifacts(requestId);
    result.content = content;
    (result as any)._meta = {
      ...(result as any)._meta,
      tyrsDesktopTiming: {
        ...message.timings,
        bridgeRoundTripMs: Math.round((performance.now() - pending.startedAt) * 100) / 100,
      },
    };
    pending.resolve(result);
  }

  private _beginToolArtifact(message: BrowserAgentMessage): void {
    const transferId = String(message.transferId || '');
    const sessionId = String(message.sessionId || '');
    const requestId = String(message.requestId || '');
    const expectedSize = Number(message.size);
    const contentType = String(message.contentType || '');
    const mimeType = String(message.mimeType || '');
    const pending = this._pendingCalls.get(requestId);
    if (!/^[0-9a-f-]{36}$/i.test(transferId) || !/^[0-9a-f-]{36}$/i.test(sessionId) ||
        !/^[0-9a-f-]{36}$/i.test(requestId) || this._artifactTransfers.has(transferId) ||
        this._completedArtifacts.has(transferId) || this._artifactTransfers.size >= 32 ||
        !Number.isInteger(expectedSize) || expectedSize < 0 || expectedSize > browserAgentMaxFileSize ||
        (contentType !== 'text' && contentType !== 'image') ||
        !mimeType || mimeType.length > 128)
      throw new Error('Invalid Browser Agent tool artifact metadata');
    this._artifactTransfers.set(transferId, {
      sessionId,
      requestId,
      contentType,
      mimeType,
      expectedSize,
      chunks: [],
      size: 0,
      discard: !pending || pending.sessionId !== sessionId,
    });
  }

  private _appendToolArtifact(message: BrowserAgentMessage): void {
    const transfer = this._artifactTransfers.get(String(message.transferId || ''));
    if (!transfer)
      throw new Error('Unknown Browser Agent tool artifact transfer');
    const encoded = String(message.data || '');
    const chunk = Buffer.from(encoded, 'base64');
    if (!encoded || chunk.toString('base64') !== encoded || chunk.length > browserAgentMaxChunkSize ||
        transfer.size + chunk.length > transfer.expectedSize)
      throw new Error('Invalid Browser Agent tool artifact chunk');
    transfer.chunks.push(chunk);
    transfer.size += chunk.length;
  }

  private async _finishToolArtifact(message: BrowserAgentMessage): Promise<void> {
    const transferId = String(message.transferId || '');
    const transfer = this._artifactTransfers.get(transferId);
    this._artifactTransfers.delete(transferId);
    const expectedDigest = String(message.sha256 || '');
    if (!transfer || transfer.size !== transfer.expectedSize || !/^[a-f0-9]{64}$/.test(expectedDigest))
      throw new Error('Incomplete Browser Agent tool artifact');
    const data = Buffer.concat(transfer.chunks);
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    if (digest !== expectedDigest)
      throw new Error('Browser Agent tool artifact checksum mismatch');
    if (!transfer.discard) {
      const content = transfer.contentType === 'text' ?
        { type: 'text' as const, text: data.toString('utf8') } :
        { type: 'image' as const, data: data.toString('base64'), mimeType: transfer.mimeType };
      this._completedArtifacts.set(transferId, {
        sessionId: transfer.sessionId,
        requestId: transfer.requestId,
        content,
      });
    }
    await this._framed.send({ type: 'artifact_ack', transferId });
  }

  private _dropToolArtifacts(requestId: string): void {
    for (const transfer of this._artifactTransfers.values()) {
      if (transfer.requestId === requestId)
        transfer.discard = true;
    }
    for (const [transferId, artifact] of this._completedArtifacts) {
      if (artifact.requestId === requestId)
        this._completedArtifacts.delete(transferId);
    }
  }

  private _interruptSession(sessionId: string, reason: string): void {
    for (const [requestId, pending] of this._pendingCalls) {
      if (pending.sessionId !== sessionId)
        continue;
      this._pendingCalls.delete(requestId);
      clearTimeout(pending.timer);
      this._dropToolArtifacts(requestId);
      if (pending.signal && pending.onAbort)
        pending.signal.removeEventListener('abort', pending.onAbort);
      pending.reject(new Error(`BROWSER_CONTROL_INTERRUPTED: ${reason}`));
    }
  }

  private _beginDownload(message: BrowserAgentMessage): void {
    const expectedSize = Number(message.size);
    const guid = String(message.guid || '');
    const transferId = String(message.transferId || '');
    if (!/^[a-zA-Z0-9_-]+$/.test(guid) || !/^[a-zA-Z0-9_-]+$/.test(transferId) ||
        this._transfers.has(transferId) || !Number.isInteger(expectedSize) || expectedSize < 0 || expectedSize > browserAgentMaxFileSize)
      throw new Error('Invalid Browser Agent download metadata');
    const sessionId = String(message.sessionId || '');
    if (!this._sessionWorkspaces.has(sessionId))
      throw new Error('Unknown Browser Agent download session');
    this._transfers.set(transferId, { sessionId, guid, expectedSize, chunks: [], size: 0 });
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
    const downloadsPath = transfer ? this._sessionWorkspaces.get(transfer.sessionId) : undefined;
    if (!transfer || transfer.size !== transfer.expectedSize || !downloadsPath ||
        !/^[a-f0-9]{64}$/.test(expectedDigest))
      throw new Error('Incomplete Browser Agent download');
    const data = Buffer.concat(transfer.chunks);
    const digest = crypto.createHash('sha256').update(data).digest('hex');
    if (digest !== expectedDigest)
      throw new Error('Browser Agent download checksum mismatch');
    await fs.promises.mkdir(downloadsPath, { recursive: true });
    const temporary = path.join(downloadsPath, `.${transfer.guid}.partial-${transferId}`);
    const target = path.join(downloadsPath, transfer.guid);
    try {
      await fs.promises.writeFile(temporary, data, { mode: 0o600 });
      await fs.promises.rename(temporary, target);
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
    await this._framed.send({ type: 'download_ack', transferId, guid: transfer.guid });
  }
}

class RemoteBrowserBackend implements ServerBackend {
  private readonly _sessionId = crypto.randomUUID();
  private _initialized = false;

  constructor(private readonly _connection: AgentConnection) {}

  async initialize(clientInfo: ClientInfo): Promise<void> {
    await this._connection.openSession(this._sessionId, clientInfo);
    this._initialized = true;
  }

  async callTool(name: string, args: mcpServer.CallToolRequest['params']['arguments'] = {}, signal?: AbortSignal): Promise<mcpServer.CallToolResult & { isClose?: boolean }> {
    return await this._connection.callTool(this._sessionId, name, args, signal);
  }

  async dispose(): Promise<void> {
    if (!this._initialized)
      return;
    this._initialized = false;
    await this._connection.finalizeSession(this._sessionId);
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

function requiredVersion(value: string | undefined, component: string): string {
  if (!value || !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(value))
    throw new Error(`invalid required ${component} version`);
  return value;
}
