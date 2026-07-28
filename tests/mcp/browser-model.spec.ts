/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import { test, expect } from './fixtures';
import { BrowserModel } from '../../packages/playwright-core/src/tools/mcp/browserModel';

test('discovers and attaches user tabs only when explicitly requested', async () => {
  const commands: Array<{ method: string, params: any }> = [];
  const events: any[] = [];
  const model = new BrowserModel(async (method, params) => {
    commands.push({ method, params });
    if (method === 'chrome.debugger.sendCommand')
      return { targetInfo: { targetId: `target-${params[0].tabId}`, type: 'page' } };
    return {};
  });
  model.connectOverCDP(message => events.push(message));
  await model.enableAutoAttach();
  expect(commands).toEqual([]);

  const count = await model.discoverTabs([
    { id: 7, index: 0, windowId: 1, url: 'https://example.com',
      title: 'Example', active: true, pinned: false },
    { id: 8, index: 1, windowId: 1, url: 'https://example.org',
      title: 'Example Org', active: false, pinned: false },
  ]);
  expect(count).toBe(2);
  expect(commands.filter(command => command.method === 'chrome.debugger.attach')).toHaveLength(2);
  expect(events.filter(event => event.method === 'Target.attachedToTarget')).toHaveLength(2);

  await model.discoverTabs([
    { id: 7, index: 0, windowId: 1, url: 'https://example.com/updated',
      title: 'Updated', active: true, pinned: false },
  ]);
  expect(commands.filter(command => command.method === 'chrome.debugger.attach')).toHaveLength(2);
});

test('creates and attaches an about:blank target before navigation', async () => {
  const commands: Array<{ method: string, params: any }> = [];
  const events: any[] = [];
  const model = new BrowserModel(async (method, params) => {
    commands.push({ method, params });
    if (method === 'chrome.tabs.create')
      return { id: 9, url: 'about:blank' };
    if (method === 'chrome.debugger.sendCommand')
      return { targetInfo: { targetId: 'target-9', type: 'page', url: 'about:blank' } };
    return {};
  });
  model.connectOverCDP(message => events.push(message));

  await expect(model.createTarget('about:blank')).resolves.toEqual({ targetId: 'target-9' });
  expect(commands).toEqual([
    { method: 'chrome.tabs.create', params: [{ url: 'about:blank' }] },
    { method: 'chrome.debugger.attach', params: [{ tabId: 9 }, '1.3'] },
    {
      method: 'chrome.debugger.sendCommand',
      params: [{ tabId: 9 }, 'Target.getTargetInfo'],
    },
  ]);
  expect(events).toContainEqual({
    method: 'Target.attachedToTarget',
    params: {
      sessionId: 'pw-tab-1',
      targetInfo: { targetId: 'target-9', type: 'page', url: 'about:blank', attached: true },
      waitingForDebugger: false,
    },
  });
});
