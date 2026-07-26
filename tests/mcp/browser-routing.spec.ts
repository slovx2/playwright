/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import { test, expect } from './fixtures';
import { RoutingBrowserBackend } from '../../packages/playwright-core/src/tools/backend/routingBrowserBackend';

test('browser selection is session scoped and routes subsequent calls', async () => {
  const calls: string[] = [];
  const backend = (id: string) => ({
    initialize: async () => {},
    dispose: async () => {},
    callTool: async (name: string) => {
      calls.push(`${id}:${name}`);
      return { content: [{ type: 'text' as const, text: id }] };
    },
  });
  const availability = {
    worker: () => ({ available: true, label: 'worker 浏览器' }),
    desktop: () => ({ available: true, label: '桌面端浏览器' }),
  };
  const first = new RoutingBrowserBackend({
    worker: async () => backend('worker') as any,
    desktop: async () => backend('desktop') as any,
  }, availability);
  const second = new RoutingBrowserBackend({
    worker: async () => backend('worker-2') as any,
    desktop: async () => backend('desktop-2') as any,
  }, availability);
  const clientInfo = { cwd: process.cwd(), clientName: 'test', scope: 'environment' };
  await first.initialize(clientInfo);
  await second.initialize(clientInfo);

  await first.callTool('browser_navigate', {});
  const selected = await first.callTool('browser_select', { browser: 'desktop' });
  expect(selected.isError).toBeFalsy();
  await first.callTool('browser_navigate', {});
  await second.callTool('browser_navigate', {});
  expect(calls).toEqual(['worker:browser_navigate', 'desktop:browser_navigate', 'worker-2:browser_navigate']);
});

test('unavailable selection keeps the current browser', async () => {
  const routing = new RoutingBrowserBackend({
    worker: async () => ({ initialize: async () => {}, dispose: async () => {},
      callTool: async () => ({ content: [{ type: 'text' as const, text: 'worker' }] }) }) as any,
    desktop: async () => { throw new Error('must not be called'); },
  }, {
    worker: () => ({ available: true, label: 'worker 浏览器' }),
    desktop: () => ({ available: false, label: '桌面端浏览器' }),
  });
  await routing.initialize({ cwd: process.cwd(), clientName: 'test', scope: 'worker' });
  const result = await routing.callTool('browser_select', { browser: 'desktop' });
  expect(result.isError).toBeTruthy();
  const status = await routing.callTool('browser_select', {});
  expect(status.content[0].type === 'text' && status.content[0].text).toContain('"current": "worker"');
});

test('a browser switch only affects calls that start afterwards', async () => {
  let releaseWorker!: () => void;
  const workerReady = new Promise<void>(resolve => releaseWorker = resolve);
  const calls: string[] = [];
  const routing = new RoutingBrowserBackend({
    worker: async () => {
      await workerReady;
      return backend('worker');
    },
    desktop: async () => backend('desktop'),
  }, {
    worker: () => ({ available: true, label: 'worker 浏览器' }),
    desktop: () => ({ available: true, label: '桌面端浏览器' }),
  });
  await routing.initialize({ cwd: process.cwd(), clientName: 'test', scope: 'environment' });
  const firstCall = routing.callTool('browser_snapshot', {});
  await routing.callTool('browser_select', { browser: 'desktop' });
  await routing.callTool('browser_snapshot', {});
  releaseWorker();
  await firstCall;
  expect(calls).toEqual(['desktop:browser_snapshot', 'worker:browser_snapshot']);

  function backend(id: string) {
    return { initialize: async () => {}, dispose: async () => {},
      callTool: async (name: string) => {
        calls.push(`${id}:${name}`);
        return { content: [{ type: 'text' as const, text: id }] };
      } } as any;
  }
});

test('concurrent calls share one session backend per selected browser', async () => {
  let factories = 0;
  const routing = new RoutingBrowserBackend({
    worker: async () => {
      factories++;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { initialize: async () => {}, dispose: async () => {},
        callTool: async () => ({ content: [{ type: 'text' as const, text: 'worker' }] }) } as any;
    },
    desktop: async () => { throw new Error('must not be called'); },
  }, {
    worker: () => ({ available: true, label: 'worker 浏览器' }),
    desktop: () => ({ available: false, label: '桌面端浏览器' }),
  });
  await routing.initialize({ cwd: process.cwd(), clientName: 'test', scope: 'worker' });
  await Promise.all([
    routing.callTool('browser_snapshot', {}),
    routing.callTool('browser_tabs', { action: 'list' }),
  ]);
  expect(factories).toBe(1);
});
