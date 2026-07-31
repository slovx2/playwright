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
import { Context } from '../../packages/playwright-core/src/tools/backend/context';

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
  return JSON.parse(result!);
}

function tabSummary(result: any) {
  return result.controlledTabs.map(tab => ({
    title: tab.title,
    url: tab.url,
    current: tab.current,
    origin: tab.origin,
  }));
}

test('list initial tabs', async ({ client }) => {
  expect(tabSummary(await tabs(client))).toEqual([
    { title: '', url: 'about:blank', current: true, origin: 'user' },
  ]);
});

test('list first tab', async ({ client }) => {
  await createTab(client, 'Tab one', 'Body one');
  expect(tabSummary(await tabs(client))).toEqual([
    { title: '', url: 'about:blank', current: false, origin: 'user' },
    { title: 'Tab one', url: 'data:text/html,<title>Tab one</title><body>Body one</body>', current: true, origin: 'agent' },
  ]);
});

test('create new tab', async ({ client }) => {
  await createTab(client, 'Tab one', 'Body one');
  await createTab(client, 'Tab two', 'Body two');
  expect(tabSummary(await tabs(client))).toEqual([
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
  expect(tabSummary(await tabs(client))).toEqual([
    { title: '', url: 'about:blank', current: false, origin: 'user' },
    { title: 'Tab one', url: 'data:text/html,<title>Tab one</title><body>Body one</body>', current: true, origin: 'agent' },
  ]);
});

test('select tab', async ({ client }) => {
  await createTab(client, 'Tab one', 'Body one');
  await createTab(client, 'Tab two', 'Body two');

  const listed = await tabs(client);
  const selected = await tabs(client, { action: 'select', tabId: listed.controlledTabs[1].tabId });
  expect(selected.controlledTabs.map(tab => tab.current)).toEqual([false, true, false]);
  const initial = await tabs(client, { action: 'select', tabId: listed.controlledTabs[0].tabId });
  expect(initial.controlledTabs.map(tab => tab.current)).toEqual([true, false, false]);
});

test('close tab', async ({ client }) => {
  await createTab(client, 'Tab one', 'Body one');
  await createTab(client, 'Tab two', 'Body two');

  const listed = await tabs(client);
  const remaining = await tabs(client, { action: 'close', tabId: listed.controlledTabs[2].tabId });
  expect(remaining.controlledTabs.map(tab => tab.title)).toEqual(['', 'Tab one']);
  expect(remaining.controlledTabs.map(tab => tab.current)).toEqual([false, true]);
});

test('cannot close or retain a user-origin tab', async ({ client }) => {
  const listed = await tabs(client);
  for (const action of ['close', 'mark_deliverable'] as const) {
    const result = await client.callTool({
      name: 'browser_tabs',
      arguments: { action, tabId: listed.controlledTabs[0].tabId },
    });
    expect(result.isError).toBeTruthy();
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('User-origin tabs cannot') }),
    ]));
  }
});

test('popup opened by a controlled tab is agent-origin', async ({ client, server }) => {
  server.setContent('/', '<button onclick="window.open(\'/popup\')">Open popup</button>', 'text/html');
  server.setContent('/popup', '<title>Popup</title><p>Popup body</p>', 'text/html');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });
  await client.callTool({ name: 'browser_snapshot' });
  await client.callTool({
    name: 'browser_click',
    arguments: { element: 'Open popup', target: 'e2' },
  });
  const listed = await tabs(client);
  expect(listed.controlledTabs).toEqual(expect.arrayContaining([
    expect.objectContaining({ title: 'Popup', origin: 'agent' }),
  ]));
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

test('agent-owned context finalizes omit tabs idempotently and retains deliverables', async ({ cdpServer }, testInfo) => {
  const browserContext = await cdpServer.start();
  const context = new Context(browserContext as any, {
    config: { defaultTabOrigin: 'agent' },
    cwd: testInfo.outputPath(),
  });
  await context.refreshTabs();
  expect(context.tabState(context.currentTabOrDie()).origin).toBe('agent');

  const deliverable = await context.newTab();
  await deliverable.page.goto('data:text/html,<title>Deliverable</title>');
  context.markTab(deliverable.id, 'deliverable');
  const omitted = await context.newTab();
  await omitted.page.goto('data:text/html,<title>Omitted</title>');

  await context.finalizeTabs();
  await context.finalizeTabs();
  expect(omitted.page.isClosed()).toBeTruthy();
  expect(deliverable.page.isClosed()).toBeFalsy();
  expect(await deliverable.page.title()).toBe('Deliverable');
  await context.dispose();
});

test('retained tab disposition and stable id survive backend recreation', async ({ cdpServer }, testInfo) => {
  const browserContext = await cdpServer.start();
  const first = new Context(browserContext as any, {
    config: { defaultTabOrigin: 'agent' },
    cwd: testInfo.outputPath(),
  });
  await first.refreshTabs();

  const deliverable = await first.newTab();
  await deliverable.page.goto('data:text/html,<title>Deliverable retained</title>');
  first.markTab(deliverable.id, 'deliverable');
  const handoff = await first.newTab();
  await handoff.page.goto('data:text/html,<title>Handoff retained</title>');
  first.markTab(handoff.id, 'handoff');
  const omitted = await first.newTab();
  await omitted.page.goto('data:text/html,<title>Omitted closed</title>');

  await first.finalizeTabs();
  await first.dispose();
  expect(omitted.page.isClosed()).toBeTruthy();

  const second = new Context(browserContext as any, {
    config: { defaultTabOrigin: 'agent' },
    cwd: testInfo.outputPath(),
  });
  await second.refreshTabs();
  const restoredDeliverable = second.tabById(deliverable.id);
  const restoredHandoff = second.tabById(handoff.id);
  expect(second.tabState(restoredDeliverable)).toEqual({ origin: 'agent', disposition: 'deliverable' });
  expect(second.tabState(restoredHandoff)).toEqual({ origin: 'agent', disposition: 'handoff' });
  await second.closeTab(deliverable.id);
  await second.closeTab(handoff.id);
  await second.dispose();
});

test('user tab claim tokens are single-use, list-scoped, page-bound, and expiring', async ({ cdpServer }, testInfo) => {
  const browserContext = await cdpServer.start();
  const context = new Context(browserContext as any, {
    config: { isolatedTabs: true },
    cwd: testInfo.outputPath(),
  });
  await context.refreshTabs();

  const stale = (await context.availableTabs())[0].claimToken;
  const current = (await context.availableTabs())[0].claimToken;
  await expect(context.claimTab(stale)).rejects.toThrow('invalid or expired');
  const claimed = await context.claimTab(current);
  expect(context.tabState(claimed).origin).toBe('user');
  await expect(context.claimTab(current)).rejects.toThrow('invalid or expired');

  const changedPage = await browserContext.newPage();
  await changedPage.goto('data:text/html,<title>Before</title>');
  const changedToken = (await context.availableTabs()).find(tab => tab.title === 'Before')!.claimToken;
  await changedPage.goto('data:text/html,<title>After</title>');
  await expect(context.claimTab(changedToken)).rejects.toThrow('changed after it was listed');

  const expiringPage = await browserContext.newPage();
  await expiringPage.goto('data:text/html,<title>Expiring</title>');
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const expiringToken = (await context.availableTabs()).find(tab => tab.title === 'Expiring')!.claimToken;
    now += 30_001;
    await expect(context.claimTab(expiringToken)).rejects.toThrow('invalid or expired');
  } finally {
    Date.now = originalNow;
  }
  await context.dispose();
});
