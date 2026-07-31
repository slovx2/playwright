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

import * as z from 'zod';
import { defineTool } from './tool';

const conditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('locator'),
    target: z.string().describe('Exact snapshot ref or unique selector.'),
    state: z.enum(['attached', 'detached', 'visible', 'hidden', 'enabled', 'disabled']),
  }),
  z.object({
    kind: z.literal('text'),
    text: z.string().min(1),
    state: z.enum(['visible', 'hidden']),
    exact: z.boolean().optional().default(false),
  }),
  z.object({
    kind: z.literal('url'),
    value: z.string().min(1),
    match: z.enum(['exact', 'glob', 'regex']).optional().default('exact'),
  }),
  z.object({
    kind: z.literal('load'),
    state: z.enum(['domcontentloaded', 'load', 'networkidle']),
  }),
  z.object({
    kind: z.literal('response'),
    url: z.string().min(1).describe('Exact URL, glob, or regular expression source.'),
    match: z.enum(['exact', 'glob', 'regex']).optional().default('glob'),
    method: z.string().optional(),
    status: z.number().int().min(100).max(599).optional(),
  }),
  z.object({
    kind: z.literal('delay'),
    delayMs: z.number().int().min(1).max(30_000),
  }),
]);

const wait = defineTool({
  capability: 'core',

  schema: {
    name: 'browser_wait_for',
    title: 'Wait for a browser condition',
    description: 'Wait for one explicit locator, text, URL, load, response, or delay condition. Prefer observable conditions over delay.',
    inputSchema: z.object({
      condition: conditionSchema,
      timeoutMs: z.number().int().min(1).max(60_000).optional().default(5_000),
    }),
    type: 'assertion',
  },

  handle: async (context, params, response, signal) => {
    const tab = context.currentTabOrDie();
    const page = tab.page;
    const timeout = params.timeoutMs;
    const condition = params.condition;

    if (condition.kind === 'delay') {
      await abortableDelay(condition.delayMs, signal);
    } else if (condition.kind === 'locator') {
      const allowMissing = condition.state === 'attached' || condition.state === 'detached' || condition.state === 'hidden';
      const { locator } = await tab.targetLocator({ target: condition.target, allowMissing });
      if (condition.state === 'enabled' || condition.state === 'disabled') {
        await poll(async () => {
          if (await locator.count() !== 1)
            return false;
          const enabled = await locator.isEnabled().catch(() => false);
          return condition.state === 'enabled' ? enabled : !enabled;
        }, timeout, signal);
      } else {
        await abortable(locator.waitFor({ state: condition.state, timeout }), signal);
      }
    } else if (condition.kind === 'text') {
      const locator = page.getByText(condition.text, { exact: condition.exact });
      if (condition.state === 'visible') {
        await abortable(locator.first().waitFor({ state: 'visible', timeout }), signal);
      } else {
        await poll(async () => {
          const count = await locator.count();
          for (let index = 0; index < count; index++) {
            if (await locator.nth(index).isVisible().catch(() => false))
              return false;
          }
          return true;
        }, timeout, signal);
      }
    } else if (condition.kind === 'url') {
      const matcher = urlMatcher(condition.value, condition.match);
      await abortable(page.waitForURL(matcher, { timeout }), signal);
    } else if (condition.kind === 'load') {
      await abortable(page.waitForLoadState(condition.state, { timeout }), signal);
    } else {
      const matcher = urlMatcher(condition.url, condition.match);
      await abortable(page.waitForResponse(candidate => {
        if (!matchesURL(candidate.url(), matcher))
          return false;
        if (condition.method && candidate.request().method().toUpperCase() !== condition.method.toUpperCase())
          return false;
        return condition.status === undefined || candidate.status() === condition.status;
      }, { timeout }), signal);
    }

    response.addTextResult(JSON.stringify({ waited: true, condition }, null, 2));
  },
});

type URLMatcher = string | RegExp | ((url: URL) => boolean);

function urlMatcher(value: string, match: 'exact' | 'glob' | 'regex'): URLMatcher {
  if (match === 'regex')
    return new RegExp(value);
  if (match === 'glob')
    return value;
  return url => url.href === value;
}

function matchesURL(value: string, matcher: URLMatcher): boolean {
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(value);
  }
  if (typeof matcher === 'function')
    return matcher(new URL(value));
  const expression = new RegExp('^' + matcher.split('*').map(escapeRegex).join('.*') + '$');
  return expression.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

async function poll(predicate: () => Promise<boolean>, timeout: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (signal?.aborted)
      throw signal.reason ?? new Error('Browser wait was cancelled');
    if (await predicate())
      return;
    await abortableDelay(Math.min(100, Math.max(1, deadline - Date.now())), signal);
  }
  throw new Error(`Browser condition timed out after ${timeout}ms`);
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal)
    return await promise;
  if (signal.aborted)
    throw signal.reason ?? new Error('Browser wait was cancelled');
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('Browser wait was cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

async function abortableDelay(time: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    throw signal.reason ?? new Error('Browser wait was cancelled');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, time);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('Browser wait was cancelled'));
    };
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export default [
  wait,
];
