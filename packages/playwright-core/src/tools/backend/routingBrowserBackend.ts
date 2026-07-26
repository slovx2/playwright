/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import * as z from 'zod';

import type { BrowserBackend } from './browserBackend';
import type * as mcpServer from '../utils/mcp/server';
import type { ClientInfo, ServerBackend } from '../utils/mcp/server';
import type { ToolSchema } from '../utils/mcp/tool';

export type BrowserId = 'worker' | 'desktop';

export const browserSelectSchema: ToolSchema<any> = {
  name: 'browser_select',
  title: 'Select browser',
  description: 'Show or select the browser used by subsequent Playwright tools. Available browsers are worker and desktop.',
  inputSchema: z.object({
    browser: z.enum(['worker', 'desktop']).optional().describe('Browser to select. Omit to show the current selection and availability.'),
  }),
  type: 'action',
};

type BackendFactory = () => Promise<BrowserBackend>;
type Availability = () => { available: boolean, label: string, details?: Record<string, unknown> };

export class RoutingBrowserBackend implements ServerBackend {
  private readonly _backends = new Map<BrowserId, Promise<BrowserBackend>>();
  private _selected: BrowserId = 'worker';
  private _clientInfo?: ClientInfo;

  constructor(
    private readonly _factories: Record<BrowserId, BackendFactory>,
    private readonly _availability: Record<BrowserId, Availability>,
  ) {}

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this._clientInfo = clientInfo;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this._backends.values()].map(async promise => {
      const backend = await promise.catch(() => undefined);
      await backend?.dispose().catch(() => {});
    }));
    this._backends.clear();
  }

  async callTool(name: string, args: mcpServer.CallToolRequest['params']['arguments'] = {}, signal?: AbortSignal): Promise<mcpServer.CallToolResult> {
    if (name === browserSelectSchema.name)
      return this._select(args);
    const selected = this._selected;
    const state = this._availability[selected]();
    if (!state.available)
      return errorResult(`${state.label}不可用；当前选择未改变，请等待恢复或调用 browser_select 切换浏览器`);
    let activeBackend: BrowserBackend | undefined;
    try {
      activeBackend = await this._backend(selected);
      const result = await activeBackend.callTool(name, args, signal);
      if (result.isClose) {
        delete result.isClose;
        this._backends.delete(selected);
        await activeBackend.dispose().catch(() => {});
      }
      return result;
    } catch (error) {
      const promise = this._backends.get(selected);
      if (activeBackend && await promise?.catch(() => undefined) === activeBackend)
        this._backends.delete(selected);
      await activeBackend?.dispose().catch(() => {});
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }

  private async _backend(browser: BrowserId): Promise<BrowserBackend> {
    let promise = this._backends.get(browser);
    if (!promise) {
      promise = (async () => {
        const backend = await this._factories[browser]();
        try {
          await backend.initialize(this._clientInfo!);
          return backend;
        } catch (error) {
          await backend.dispose().catch(() => {});
          throw error;
        }
      })().catch(error => {
        this._backends.delete(browser);
        throw error;
      });
      this._backends.set(browser, promise);
    }
    return await promise;
  }

  private _select(rawArguments: mcpServer.CallToolRequest['params']['arguments']): mcpServer.CallToolResult {
    const parsed = browserSelectSchema.inputSchema.safeParse(rawArguments || {});
    if (!parsed.success)
      return errorResult(`browser_select 参数无效：${z.prettifyError(parsed.error)}`);
    const target = parsed.data.browser as BrowserId | undefined;
    if (target) {
      const state = this._availability[target]();
      if (!state.available)
        return errorResult(`${state.label}当前不可用，仍使用${this._availability[this._selected]().label}`);
      this._selected = target;
    }
    const browsers = (['worker', 'desktop'] as const).map(id => ({ id, ...this._availability[id]() }));
    return {
      content: [{ type: 'text', text: JSON.stringify({ current: this._selected, browsers }, null, 2) }],
    };
  }
}

function errorResult(message: string): mcpServer.CallToolResult {
  return { content: [{ type: 'text', text: `### Error\n${message}` }], isError: true };
}
