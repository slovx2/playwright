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

import debug from 'debug';
import { createHttpServer, startHttpServer } from '@utils/network';
import { playwright } from '../../inprocess';
import { CDPRelayServer } from './cdpRelay';

import type * as playwrightTypes from '../../..';

const debugLogger = debug('pw:mcp:relay');

export async function createExtensionBrowser(channel: string, executablePath: string | undefined, clientName: string): Promise<playwrightTypes.Browser> {
  const httpServer = createHttpServer();
  const relayPort = Number(process.env.TYRS_BROWSER_RELAY_PORT);
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535)
    throw new Error('invalid TYRS_BROWSER_RELAY_PORT');
  await startHttpServer(httpServer, { host: '127.0.0.1', port: relayPort });
  const relay = new CDPRelayServer(httpServer, channel, executablePath);
  debugLogger(`CDP relay server started, extension endpoint: ${relay.extensionEndpoint()}.`);

  try {
    await relay.establishExtensionConnection(clientName);
    const browser = await playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: 0 });
    browser.on('disconnected', () => {
      relay.stop();
      httpServer.close();
    });
    return browser;
  } catch (error) {
    relay.stop();
    httpServer.close();
    throw error;
  }
}
