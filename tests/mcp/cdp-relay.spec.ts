/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import http from 'http';

import WebSocket from 'ws';

import { test, expect } from './fixtures';
import { CDPRelayServer } from '../../packages/playwright-core/src/tools/mcp/cdpRelay';

test('CDP relay rejects an old profile before it can occupy the extension connection', async () => {
  const previous = {
    token: process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN,
    version: process.env.PLAYWRIGHT_MCP_EXTENSION_VERSION,
    protocol: process.env.PLAYWRIGHT_EXTENSION_PROTOCOL,
    capability: process.env.PLAYWRIGHT_MCP_EXTENSION_CAPABILITY_VERSION,
  };
  process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = 'test-token';
  process.env.PLAYWRIGHT_MCP_EXTENSION_VERSION = '0.3.1';
  process.env.PLAYWRIGHT_EXTENSION_PROTOCOL = '2';
  process.env.PLAYWRIGHT_MCP_EXTENSION_CAPABILITY_VERSION = '1';

  const server = http.createServer();
  await new Promise<void>((resolve, reject) =>
    server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const relay = new CDPRelayServer(server, 'chrome');
  try {
    let disconnected!: (reason: string) => void;
    const extensionDisconnected = new Promise<string>(resolve => disconnected = resolve);
    relay.setDelegate({ onExtensionDisconnected: reason => disconnected(reason) });
    const endpoint = relay.extensionEndpoint();
    const oldProfile = new WebSocket(`${endpoint}?token=test-token`);
    const closed = new Promise<{ code: number, reason: string }>(resolve =>
      oldProfile.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    expect(await closed).toEqual({ code: 4002, reason: 'Incompatible extension connection' });

    const currentProfile = new WebSocket(
        `${endpoint}?token=test-token&extensionVersion=0.3.1&extensionProtocol=2&capabilityVersion=1`);
    currentProfile.on('message', data => {
      const message = JSON.parse(data.toString());
      currentProfile.send(JSON.stringify({ id: message.id, result: undefined }));
    });
    await new Promise<void>((resolve, reject) => {
      currentProfile.once('open', resolve);
      currentProfile.once('error', reject);
    });
    await expect(relay.extensionCommand('tyrs.sessions.reset', [])).resolves.toBeUndefined();
    currentProfile.close(1000, 'current profile stopped');
    await expect(extensionDisconnected).resolves.toBe('current profile stopped');
  } finally {
    relay.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    restoreEnv('PLAYWRIGHT_MCP_EXTENSION_TOKEN', previous.token);
    restoreEnv('PLAYWRIGHT_MCP_EXTENSION_VERSION', previous.version);
    restoreEnv('PLAYWRIGHT_EXTENSION_PROTOCOL', previous.protocol);
    restoreEnv('PLAYWRIGHT_MCP_EXTENSION_CAPABILITY_VERSION', previous.capability);
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined)
    delete process.env[name];
  else
    process.env[name] = value;
}
