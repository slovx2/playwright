/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'assert';
import net from 'net';
import http from 'http';
import crypto from 'crypto';

import debug from 'debug';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { urlHostFromAddress } from '@utils/httpServer';
import { createHttpServer, startHttpServer } from '@utils/network';
import { ManualPromise } from '@isomorphic/manualPromise';

import * as mcpServer from './server';

import type { ServerBackendFactory } from './server';
import type { SSEServerTransport as SSEServerTransportType } from '@modelcontextprotocol/sdk/server/sse.js';
import type { StreamableHTTPServerTransport as StreamableHTTPServerTransportType } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const testDebug = debug('pw:mcp:test');

export async function startMcpHttpServer(
  config: { host?: string, port?: number },
  serverBackendFactory: ServerBackendFactory,
  allowedHosts?: string[]
): Promise<string> {
  const httpServer = createHttpServer();
  await startHttpServer(httpServer, config);
  return await installHttpTransport(httpServer, serverBackendFactory, allowedHosts);
}

export function addressToString(address: string | net.AddressInfo | null, options: {
  protocol: 'http' | 'ws';
  normalizeLoopback?: boolean;
}): string {
  assert(address, 'Could not bind server socket');
  if (typeof address === 'string')
    throw new Error('Unexpected address type: ' + address);
  let host = urlHostFromAddress(address);
  if (options.normalizeLoopback && (host === '0.0.0.0' || host === '[::]' || host === '[::1]' || host === '127.0.0.1'))
    host = 'localhost';
  return `${options.protocol}://${host}:${address.port}`;
}

async function installHttpTransport(httpServer: http.Server, serverBackendFactory: ServerBackendFactory, allowedHosts?: string[]) {
  const url = addressToString(httpServer.address(), { protocol: 'http', normalizeLoopback: true });
  const host = new URL(url).host;
  allowedHosts = (allowedHosts || [host]).map(h => h.toLowerCase());
  const allowAnyHost = allowedHosts.includes('*');

  const sseSessions = new Map<string, { transport: SSEServerTransportType, scope: string, taskId?: string }>();
  const streamableSessions = new Map();
  httpServer.on('request', async (req, res) => {
    if (!allowAnyHost) {
      const host = req.headers.host?.toLowerCase();
      if (!host) {
        res.statusCode = 400;
        return res.end('Missing host');
      }

      // Prevent DNS evil.com -> localhost rebind.
      if (!allowedHosts.includes(host)) {
        // Access from the browser is forbidden.
        res.statusCode = 403;
        return res.end('Access is only allowed at ' + allowedHosts.join(', '));
      }
    }

    const url = new URL(`http://localhost${req.url}`);
    if (url.pathname === '/killkillkill') {
      // Require POST plus a custom header to prevent cross-origin CSRF
      // (a browser-coerced <img> GET or simple <form> POST can't add custom headers,
      // and any cross-origin request with custom headers is blocked by CORS preflight).
      if (req.method !== 'POST' || req.headers['x-pw-mcp-kill'] !== '1') {
        res.statusCode = 405;
        return res.end();
      }
      res.statusCode = 200;
      res.end('Killing process');
      // Simulate Ctrl+C in a way that works on Windows too.
      process.emit('SIGINT');
      return;
    }
    if (url.pathname === '/browser-agent-health' && req.method === 'GET') {
      if (!serverBackendFactory.health) {
        res.statusCode = 404;
        return res.end('Browser Agent registry is not configured');
      }
      const data = JSON.stringify(serverBackendFactory.health());
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
        'cache-control': 'no-store' });
      return res.end(data);
    }
    const client = requestClient(req);
    if (!client) {
      res.statusCode = 400;
      return res.end('Invalid browser scope');
    }
    if (url.pathname === '/browser-services/task/end') {
      if (req.method !== 'POST' || !client.taskId) {
        res.statusCode = 400;
        return res.end('Invalid task service cleanup request');
      }
      try {
        await mcpServer.disposeTaskBackends(serverBackendFactory, client.scope, client.taskId);
        await serverBackendFactory.releaseTask?.(client.scope, client.taskId);
        res.statusCode = 204;
        return res.end();
      } catch {
        res.statusCode = 500;
        return res.end('Task cleanup failed');
      }
    }
    if (url.pathname === '/browser-services/environment/end') {
      if (req.method !== 'POST' || client.scope === 'worker' || !serverBackendFactory.closeScope) {
        res.statusCode = 400;
        return res.end('Invalid environment service cleanup request');
      }
      await serverBackendFactory.closeScope(client.scope);
      res.statusCode = 204;
      return res.end();
    }
    if (url.pathname.startsWith('/sse'))
      await handleSSE(serverBackendFactory, req, res, url, sseSessions, client);
    else
      await handleStreamable(serverBackendFactory, req, res, streamableSessions, client);
  });

  return url;
}

type RequestClient = { scope: string, taskId?: string };

async function handleSSE(serverBackendFactory: ServerBackendFactory, req: http.IncomingMessage, res: http.ServerResponse, url: URL, sessions: Map<string, { transport: SSEServerTransportType, scope: string, taskId?: string }>, client: RequestClient) {
  if (req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.statusCode = 400;
      return res.end('Missing sessionId');
    }

    const sessionInfo = sessions.get(sessionId);
    if (!sessionInfo) {
      res.statusCode = 404;
      return res.end('Session not found');
    }
    if (sessionInfo.scope !== client.scope || sessionInfo.taskId !== client.taskId) {
      res.statusCode = 403;
      return res.end('MCP session belongs to another browser scope');
    }

    return await sessionInfo.transport.handlePostMessage(req, res);
  } else if (req.method === 'GET') {
    const transport = new SSEServerTransport('/sse', res);
    sessions.set(transport.sessionId, { transport, ...client });
    testDebug(`create SSE session`);
    await mcpServer.connect(serverBackendFactory, transport, Promise.resolve(), false, client.scope, client.taskId);
    res.on('close', () => {
      testDebug(`delete SSE session`);
      sessions.delete(transport.sessionId);
    });
    return;
  }

  res.statusCode = 405;
  res.end('Method not allowed');
}

async function handleStreamable(serverBackendFactory: ServerBackendFactory, req: http.IncomingMessage, res: http.ServerResponse, sessions: Map<string, { transport: StreamableHTTPServerTransportType, transportInitialized: ManualPromise<void>, scope: string, taskId?: string }>, client: RequestClient) {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (sessionId) {
    const sessionInfo = sessions.get(sessionId);
    if (!sessionInfo) {
      res.statusCode = 404;
      res.end('Session not found');
      return;
    }
    if (sessionInfo.scope !== client.scope || sessionInfo.taskId !== client.taskId) {
      res.statusCode = 403;
      res.end('MCP session belongs to another browser scope');
      return;
    }
    if (req.method === 'GET') {
      // As per spec, GET is for the event stream only, when we see it consider transport bidirectionally ready.
      const streamResponse = sessionInfo.transport.handleRequest(req, res);
      sessionInfo.transportInitialized.resolve();
      return streamResponse;
    }
    return sessionInfo.transport.handleRequest(req, res);
  }

  if (req.method === 'POST') {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      // Codex 0.145 会丢失 tools/call POST 中延迟到达的首个 SSE 事件。
      // 直接返回 JSON，确保长时间工具调用始终和原请求关联。
      enableJsonResponse: true,
      onsessioninitialized: async sessionId => {
        testDebug(`create http session`);
        const sessionInfo = { transport, transportInitialized: new ManualPromise<void>(), ...client };
        // Only give the client 5 seconds to reach for the event stream.
        setTimeout(() => sessionInfo.transportInitialized.resolve(), 5000);
        sessions.set(sessionId, sessionInfo);
        await mcpServer.connect(serverBackendFactory, sessionInfo.transport, sessionInfo.transportInitialized, true, client.scope, client.taskId);
      }
    });

    transport.onclose = () => {
      if (!transport.sessionId)
        return;
      sessions.delete(transport.sessionId);
      testDebug(`delete http session`);
    };

    await transport.handleRequest(req, res);
    return;
  }

  res.statusCode = 400;
  res.end('Invalid request');
}

function requestClient(req: http.IncomingMessage): RequestClient | undefined {
  const value = req.headers['x-tyrs-browser-scope'];
  const scope = typeof value !== 'string' || !value ? 'worker' : value.toLowerCase();
  if (scope !== 'worker' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(scope))
    return undefined;
  const taskValue = req.headers['x-tyrs-browser-task-id'];
  if (taskValue !== undefined && (typeof taskValue !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskValue)))
    return undefined;
  if (scope === 'worker' && taskValue)
    return { scope, taskId: taskValue.toLowerCase() };
  if (scope !== 'worker')
    return { scope, taskId: typeof taskValue === 'string' ? taskValue.toLowerCase() : undefined };
  return { scope };
}
