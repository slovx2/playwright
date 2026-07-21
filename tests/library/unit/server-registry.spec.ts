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

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { test as it, expect } from '@playwright/test';
import { serverRegistry } from '../../../packages/playwright-core/lib/serverRegistry';

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function writeDescriptor(dir: string, guid: string, endpoint: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, guid), JSON.stringify({
    playwrightVersion: '1.0.0',
    playwrightLib: '',
    title: guid,
    browser: { guid, browserName: 'chromium', launchOptions: {} },
    endpoint,
  }));
}

it.describe('serverRegistry health check', () => {
  let registryDir: string;
  let servers: net.Server[];

  it.beforeEach(() => {
    registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-registry-'));
    process.env.PWTEST_SERVER_REGISTRY = registryDir;
    servers = [];
  });

  it.afterEach(async () => {
    delete process.env.PWTEST_SERVER_REGISTRY;
    for (const server of servers)
      await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(registryDir, { recursive: true, force: true });
  });

  it('should keep a registration whose first connection probe fails but recovers', async () => {
    const guid = 'guid-recovers';
    const port = await freePort();
    // Endpoint is initially unreachable (port refused), so the first probe(s) fail.
    writeDescriptor(registryDir, guid, `ws://127.0.0.1:${port}`);

    // Bring the endpoint up shortly after, mid-way through the probe retries.
    const listening = new Promise<void>(resolve => {
      setTimeout(() => {
        const server = net.createServer(socket => socket.destroy());
        servers.push(server);
        server.listen(port, '127.0.0.1', resolve);
      }, 300);
    });

    const [result] = await Promise.all([serverRegistry.list(), listening]);
    const descriptors = [...result.values()].flat();
    expect(descriptors.map(d => d.browser.guid)).toContain(guid);
    // A transient probe failure must not evict a live registration from disk.
    expect(fs.existsSync(path.join(registryDir, guid))).toBe(true);
  });

  it('should evict a registration whose endpoint never becomes reachable', async () => {
    const guid = 'guid-dead';
    const port = await freePort();
    writeDescriptor(registryDir, guid, `ws://127.0.0.1:${port}`);

    const result = await serverRegistry.list();
    const descriptors = [...result.values()].flat();
    expect(descriptors.map(d => d.browser.guid)).not.toContain(guid);
    expect(fs.existsSync(path.join(registryDir, guid))).toBe(false);
  });
});
