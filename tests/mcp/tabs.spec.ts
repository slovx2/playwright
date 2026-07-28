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

import { test, expect } from './fixtures';

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

async function createTab(client: Client, title: string, body: string) {
  await client.callTool({
    name: 'browser_tabs',
    arguments: {
      action: 'new',
    },
  });
  return await client.callTool({
    name: 'browser_navigate',
    arguments: {
      url: `data:text/html,<title>${title}</title><body>${body}</body>`,
    },
  });
}

async function tabs(client: Client, action: Record<string, unknown> = { action: 'list' }) {
  const response = await client.callTool({ name: 'browser_tabs', arguments: action });
  const text = response.content.find(item => item.type === 'text')?.text || '';
  const result = text.match(/### Result\n([\s\S]*?)(?:\n### |$)/)?.[1];
  expect(result).toBeTruthy();
  return JSON.parse(result!).tabs.map(tab => ({
    title: tab.title,
    url: tab.url,
    current: tab.current,
    origin: tab.origin,
  }));
}

test('list initial tabs', async ({ client }) => {
  expect(await tabs(client)).toEqual([
    { title: '', url: 'about:blank', current: true, origin: 'user' },
  ]);
});

test('list first tab', async ({ client }) => {
  await createTab(client, 'Tab one', 'Body one');
  expect(await tabs(client)).toEqual([
    { title: '', url: 'about:blank', current: false, origin: 'user' },
    { title: 'Tab one', url: 'data:text/html,<title>Tab one</title><body>Body one</body>', current: true, origin: 'agent' },
  ]);
});

test('create new tab', async ({ client }) => {
  await createTab(client, 'Tab one', 'Body one');
  await createTab(client, 'Tab two', 'Body two');
  expect(await tabs(client)).toEqual([
    { title: '', url: 'about:blank', current: false, origin: 'user' },
    { title: 'Tab one', url: 'data:text/html,<title>Tab one</title><body>Body one</body>', current: false, origin: 'agent' },
    { title: 'Tab two', url: 'data:text/html,<title>Tab two</title><body>Body two</body>', current: true, origin: 'agent' },
  ]);
  expect(await client.callTool({
    name: 'browser_snapshot',
    arguments: {},
  })).toHaveResponse({
    page: expect.stringContaining('Page URL: data:text/html,<title>Tab two</title><body>Body two</body>'),
    inlineSnapshot: expect.stringContaining('Body two'),
  });
});

test('create new tab with url', async ({ client }) => {
  await tabs(client, {
    action: 'new',
    url: `data:text/html,<title>Tab one</title><body>Body one</body>`,
  });
  expect(await tabs(client)).toEqual([
    { title: '', url: 'about:blank', current: false, origin: 'user' },
    { title: 'Tab one', url: 'data:text/html,<title>Tab one</title><body>Body one</body>', current: true, origin: 'agent' },
  ]);
});

test('select tab', async ({ client }) => {
  await createTab(client, 'Tab one', 'Body one');
  await createTab(client, 'Tab two', 'Body two');

  const selected = await tabs(client, { action: 'select', index: 1 });
  expect(selected.map(tab => tab.current)).toEqual([false, true, false]);
  const initial = await tabs(client, { action: 'select', index: 0 });
  expect(initial.map(tab => tab.current)).toEqual([true, false, false]);
});

test('close tab', async ({ client }) => {
  await createTab(client, 'Tab one', 'Body one');
  await createTab(client, 'Tab two', 'Body two');

  const remaining = await tabs(client, { action: 'close', index: 2 });
  expect(remaining.map(tab => tab.title)).toEqual(['', 'Tab one']);
  expect(remaining.map(tab => tab.current)).toEqual([false, true]);
});

test('reuse first tab when navigating', async ({ startClient, cdpServer, server }) => {
  const browserContext = await cdpServer.start();
  const pages = browserContext.pages();

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });
  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  });

  expect(pages.length).toBe(1);
  expect(await pages[0].title()).toBe('Title');
});
