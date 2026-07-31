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

test('browser_wait_for(text)', async ({ client, server }) => {
  server.setContent('/', `
    <script>
      function update() {
        setTimeout(() => {
          document.querySelector('div').textContent = 'Text to appear';
        }, 1000);
      }
    </script>
    <body>
      <button onclick="update()">Click me</button>
      <div>Text to disappear</div>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(await client.callTool({ name: 'browser_snapshot' })).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`- generic [ref=e3]: Text to disappear`),
  });

  await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Click me',
      target: 'e2',
    },
  });

  await client.callTool({
    name: 'browser_wait_for',
    arguments: { condition: { kind: 'text', text: 'Text to appear', state: 'visible' } },
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`- generic [ref=e3]: Text to appear`),
  });
});

test('browser_wait_for(textGone)', async ({ client, server }) => {
  server.setContent('/', `
    <script>
      function update() {
        setTimeout(() => {
          document.querySelector('div').textContent = 'Text to appear';
        }, 1000);
      }
    </script>
    <body>
      <button onclick="update()">Click me</button>
      <div>Text to disappear</div>
    </body>
  `, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });
  expect(await client.callTool({ name: 'browser_snapshot' })).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`- generic [ref=e3]: Text to disappear`),
  });

  await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Click me',
      target: 'e2',
    },
  });

  await client.callTool({
    name: 'browser_wait_for',
    arguments: { condition: { kind: 'text', text: 'Text to disappear', state: 'hidden' } },
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    inlineSnapshot: expect.stringContaining(`- generic [ref=e3]: Text to appear`),
  });
});

test('browser_wait_for(time)', async ({ client, server }) => {
  server.setContent('/', `<body><div>Hello World</div></body>`, 'text/html');

  await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  });

  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { condition: { kind: 'delay', delayMs: 1000 } },
  })).toHaveResponse({
    result: expect.stringContaining('"waited": true'),
  });
});

test('browser_wait_for URL, locator, and response conditions', async ({ client, server }) => {
  server.setContent('/', `
    <div id="status">Loading</div>
    <script>
      setTimeout(async () => {
        await fetch('/ready');
        document.querySelector('#status').hidden = true;
        location.hash = 'done';
      }, 300);
    </script>
  `, 'text/html');
  server.setContent('/ready', 'ready', 'text/plain');
  await client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX } });

  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { condition: { kind: 'response', url: '**/ready', status: 200 }, timeoutMs: 2000 },
  })).toHaveResponse({ result: expect.stringContaining('"waited": true') });
  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { condition: { kind: 'locator', target: '#status', state: 'hidden' }, timeoutMs: 2000 },
  })).toHaveResponse({ result: expect.stringContaining('"waited": true') });
  expect(await client.callTool({
    name: 'browser_wait_for',
    arguments: { condition: { kind: 'url', value: `${server.PREFIX}/#done`, match: 'exact' }, timeoutMs: 2000 },
  })).toHaveResponse({ result: expect.stringContaining('"waited": true') });
});
