/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import { test, expect } from './fixtures';
import { RoutingBrowserBackend } from '../../packages/playwright-core/src/tools/backend/routingBrowserBackend';
import { redactSensitiveData } from '../../packages/playwright-core/src/tools/backend/context';
import { readsSensitiveBrowserState } from '../../packages/playwright-core/src/tools/backend/evaluate';

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

test('dispose finalizes every initialized browser backend', async () => {
  const calls: string[] = [];
  const makeBackend = (id: string) => ({
    initialize: async () => {},
    dispose: async () => { calls.push(`${id}:dispose`); },
    callTool: async (name: string, args: any) => {
      calls.push(`${id}:${name}:${args.action || ''}`);
      return { content: [{ type: 'text' as const, text: '{}' }] };
    },
  });
  const routing = new RoutingBrowserBackend({
    worker: async () => makeBackend('worker') as any,
    desktop: async () => makeBackend('desktop') as any,
  }, {
    worker: () => ({ available: true, label: 'worker' }),
    desktop: () => ({ available: true, label: 'desktop' }),
  });
  await routing.initialize({ cwd: process.cwd(), clientName: 'test', scope: 'environment', taskId: 'task' });
  await routing.callTool('browser_snapshot', {});
  await routing.callTool('browser_select', { browser: 'desktop' });
  await routing.callTool('browser_snapshot', {});
  await routing.dispose();
  expect(calls).toContain('worker:browser_tabs:finalize');
  expect(calls).toContain('desktop:browser_tabs:finalize');
  expect(calls).toContain('worker:dispose');
  expect(calls).toContain('desktop:dispose');
});

test('recoverable timeout preserves the selected backend', async () => {
  let factories = 0;
  let calls = 0;
  const routing = new RoutingBrowserBackend({
    worker: async () => {
      factories++;
      return { initialize: async () => {}, dispose: async () => {}, callTool: async () => {
        if (!calls++)
          throw new Error('Desktop browser tool timed out');
        return { content: [{ type: 'text' as const, text: 'recovered' }] };
      } } as any;
    },
    desktop: async () => { throw new Error('must not be called'); },
  }, {
    worker: () => ({ available: true, label: 'worker' }),
    desktop: () => ({ available: false, label: 'desktop' }),
  });
  await routing.initialize({ cwd: process.cwd(), clientName: 'test', scope: 'worker' });
  const failed = await routing.callTool('browser_snapshot', {});
  expect(failed.isError).toBeTruthy();
  expect(failed.content[0].type === 'text' && failed.content[0].text).toContain('"sessionPreserved": true');
  const recovered = await routing.callTool('browser_snapshot', {});
  expect(recovered.isError).toBeFalsy();
  expect(factories).toBe(1);
});

test('Tyrs browser output redacts credentials and password HTML', () => {
  const redacted = redactSensitiveData([
    'Authorization: Bearer abc',
    'Set-Cookie: sid=secret',
    'https://example.com/?api_key=abc&name=visible',
    '{"token":"abc","name":"visible"}',
    '<input type="password" value="abc"><input value="visible">',
  ].join('\n'));
  expect(redacted).not.toContain('Bearer abc');
  expect(redacted).not.toContain('sid=secret');
  expect(redacted).not.toContain('api_key=abc');
  expect(redacted).not.toContain('"token":"abc"');
  expect(redacted).not.toContain('type="password" value="abc"');
  expect(redacted).toContain('name=visible');
  expect(redacted).toContain('"name":"visible"');
  expect(redacted).toContain('<input value="visible">');
  expect(readsSensitiveBrowserState('() => document.cookie')).toBeTruthy();
  expect(readsSensitiveBrowserState('() => document["cookie"]')).toBeTruthy();
  expect(readsSensitiveBrowserState('() => localStorage.getItem("token")')).toBeTruthy();
  expect(readsSensitiveBrowserState('() => navigator["credentials"].get()')).toBeTruthy();
  expect(readsSensitiveBrowserState('() => document.querySelector("input[type=password]").value')).toBeTruthy();
  expect(readsSensitiveBrowserState('() => document.title')).toBeFalsy();
});
