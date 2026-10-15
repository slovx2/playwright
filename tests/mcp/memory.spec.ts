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

import v8 from 'v8';
import vm from 'vm';

import { test, expect } from './fixtures';
import { Context } from '../../packages/playwright-core/src/tools/backend/context';
import { BrowserBackend } from '../../packages/playwright-core/src/tools/backend/browserBackend';
import { Tab, maxCollectedRequests, maxRecentEventEntries } from '../../packages/playwright-core/src/tools/backend/tab';
import tabsTools from '../../packages/playwright-core/src/tools/backend/tabs';

import type * as playwright from 'playwright-core';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

async function collectGarbage() {
  for (let i = 0; i < 5; i++) {
    gc();
    await new Promise(f => setTimeout(f, 10));
  }
}

function listenerCount(emitter: object, event: string): number {
  return (emitter as any).listenerCount(event);
}

async function fetchMany(page: playwright.Page, count: number) {
  await page.evaluate(async count => {
    for (let start = 0; start < count; start += 50) {
      const batch = [];
      for (let i = start; i < Math.min(start + 50, count); i++)
        batch.push(fetch(`/empty.html?r=${i}`).then(r => r.text()));
      await Promise.all(batch);
    }
  }, count);
}

test('disposed context releases its tabs and stops listening to shared pages', async ({ cdpServer, server }, testInfo) => {
  const browserContext = await cdpServer.start();
  const page = browserContext.pages()[0];
  const baselineRequestListeners = listenerCount(page, 'request');
  const baselineCloseListeners = listenerCount(page, 'close');
  const context = new Context(browserContext as any, {
    config: {},
    cwd: testInfo.outputPath(),
  });
  await context.refreshTabs();
  const tab = context.currentTabOrDie();
  await tab.navigate(server.EMPTY_PAGE);
  await fetchMany(page, 5);
  expect((await tab.requests()).length).toBeGreaterThan(0);
  expect(Tab.forPage(page)).toBe(tab);
  expect(listenerCount(page, 'request')).toBe(baselineRequestListeners + 1);
  context.beginToolCall();
  await context.availableTabs();

  await context.dispose();

  expect(Tab.forPage(page)).toBeUndefined();
  expect(await tab.requests()).toEqual([]);
  expect(context.tabs()).toEqual([]);
  expect((context as any)._tabStates.size).toBe(0);
  expect((context as any)._tabClaims.size).toBe(0);
  expect(listenerCount(page, 'request')).toBe(baselineRequestListeners);
  expect(listenerCount(page, 'close')).toBe(baselineCloseListeners);

  // 会话结束后页面继续产生请求，已释放的 Tab 不再收集。
  await fetchMany(page, 5);
  expect(await tab.requests()).toEqual([]);
});

test('disposed context removes its routes from the shared browser context', async ({ cdpServer, server }, testInfo) => {
  const browserContext = await cdpServer.start();
  const context = new Context(browserContext as any, {
    config: {},
    cwd: testInfo.outputPath(),
  });
  await context.addRoute({
    pattern: '**/routed.html',
    handler: route => route.fulfill({ body: 'routed by session' }),
  });
  const page = browserContext.pages()[0];
  await page.goto(server.PREFIX + '/routed.html');
  expect(await page.textContent('body')).toBe('routed by session');

  await context.dispose();

  expect(context.routes()).toEqual([]);
  const response = await page.goto(server.PREFIX + '/routed.html');
  expect(response?.status()).toBe(404);
});

test('disposed backend detaches from the shared browser and becomes collectable', async ({ cdpServer, server }, testInfo) => {
  const browserContext = await cdpServer.start();
  const browser = browserContext.browser()!;
  const page = browserContext.pages()[0];
  const baselineContextClose = listenerCount(browserContext, 'close');
  const baselineDisconnected = listenerCount(browser, 'disconnected');

  const refs = await (async () => {
    const backend = new BrowserBackend({}, browserContext as any, tabsTools);
    await backend.initialize({ clientName: 'memory test', cwd: testInfo.outputPath(), scope: 'worker' });
    expect(listenerCount(browserContext, 'close')).toBe(baselineContextClose + 1);
    expect(listenerCount(browser, 'disconnected')).toBe(baselineDisconnected + 1);
    await backend.callTool('browser_tabs', { action: 'list' });
    const context = (backend as any)._context as Context;
    const tab = context.currentTabOrDie();
    await tab.navigate(server.EMPTY_PAGE);
    await fetchMany(page, 5);
    await backend.dispose();
    return { backend: new WeakRef(backend), context: new WeakRef(context), tab: new WeakRef(tab) };
  })();

  expect(listenerCount(browserContext, 'close')).toBe(baselineContextClose);
  expect(listenerCount(browser, 'disconnected')).toBe(baselineDisconnected);
  // 共享的浏览器与 page 还活着，会话对象应能被回收。
  await expect.poll(async () => {
    await collectGarbage();
    return [refs.backend.deref(), refs.context.deref(), refs.tab.deref()];
  }).toEqual([undefined, undefined, undefined]);
  expect(page.isClosed()).toBe(false);
});

test('tab keeps only the most recent requests and events', async ({ cdpServer, server }, testInfo) => {
  const browserContext = await cdpServer.start();
  const context = new Context(browserContext as any, {
    config: {},
    cwd: testInfo.outputPath(),
  });
  await context.refreshTabs();
  const tab = context.currentTabOrDie();
  await tab.navigate(server.EMPTY_PAGE);
  const count = Math.max(maxCollectedRequests, maxRecentEventEntries) + 100;
  await fetchMany(tab.page, count);

  const requests = await tab.requests();
  expect(requests).toHaveLength(maxCollectedRequests);
  const urls = requests.map(request => request.url());
  expect(urls.some(url => url.endsWith(`r=${count - 1}`))).toBe(true);
  expect(urls.some(url => url.endsWith('r=0'))).toBe(false);
  const events = (tab as any)._recentEventEntries;
  expect(events).toHaveLength(maxRecentEventEntries);
  await context.dispose();
});
