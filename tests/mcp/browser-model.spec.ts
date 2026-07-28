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
