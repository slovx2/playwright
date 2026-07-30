/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import crypto from 'crypto';
import * as z from 'zod';

import type * as mcpServer from '../utils/mcp/server';
import type { ClientInfo, ServerBackend } from '../utils/mcp/server';
import type { ToolSchema } from '../utils/mcp/tool';
import type { BrowserServiceManager, ServiceLifetime } from './browserServiceManager';

export type BrowserId = 'worker' | 'desktop';

export const browserSelectSchema: ToolSchema<any> = {
  name: 'browser_select',
  title: 'Select browser',
  description: 'Show or select the browser used by subsequent Playwright tools and loopback service tunnels. Available browsers are worker and desktop.',
  inputSchema: z.object({
    browser: z.enum(['worker', 'desktop']).optional().describe('Browser to select. Omit to show the current selection and availability.'),
  }),
  type: 'action',
};

export const browserExposeServiceSchema: ToolSchema<any> = {
  name: 'browser_expose_service',
  title: 'Expose development service',
  description: 'Expose a development-environment service listening on 127.0.0.1 through a TCP endpoint bound to the selected execution machine loopback.',
  inputSchema: z.object({
    port: z.number().int().min(1).max(65535).describe('Development-environment loopback TCP port.'),
    lifetime: z.enum(['task', 'review']).optional().default('task').describe('task closes at task end; review remains until closed or idle for 24 hours.'),
  }),
  type: 'action',
};

export const browserListServicesSchema: ToolSchema<any> = {
  name: 'browser_list_services',
  title: 'List exposed services',
  description: 'List loopback TCP services exposed for the current environment and selected execution machine.',
  inputSchema: z.object({}),
  type: 'readOnly',
};

export const browserCloseServiceSchema: ToolSchema<any> = {
  name: 'browser_close_service',
  title: 'Close exposed service',
  description: 'Close an exposed loopback TCP service owned by the current environment and selected execution machine.',
  inputSchema: z.object({
    id: z.string().regex(/^service-[0-9a-f-]{36}$/i).describe('Service ID returned by browser_expose_service.'),
  }),
  type: 'action',
};

export const browserServiceSchemas = [
  browserExposeServiceSchema,
  browserListServicesSchema,
  browserCloseServiceSchema,
];

type BackendFactory = () => Promise<ServerBackend>;
type Availability = () => {
  available: boolean;
  label: string;
  reason?: string;
  version?: string;
  capabilities?: string[];
  details?: Record<string, unknown>;
};

export class RoutingBrowserBackend implements ServerBackend {
  private readonly _backends = new Map<BrowserId, Promise<ServerBackend>>();
  private _selected: BrowserId = 'worker';
  private _clientInfo?: ClientInfo;
  private _taskId?: string;

  constructor(
    private readonly _factories: Record<BrowserId, BackendFactory>,
    private readonly _availability: Record<BrowserId, Availability>,
    private readonly _services?: BrowserServiceManager,
  ) {}

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this._clientInfo = clientInfo;
    this._taskId = clientInfo.taskId || (clientInfo.scope === 'worker' ? undefined : crypto.randomUUID());
  }

  async dispose(): Promise<void> {
    await Promise.all([...this._backends.values()].map(async promise => {
      const backend = await promise.catch(() => undefined);
      await backend?.dispose?.().catch(() => {});
    }));
    this._backends.clear();
    if (this._clientInfo && this._taskId)
      await this._services?.releaseTask(this._clientInfo.scope, this._taskId);
  }

  async callTool(name: string, args: mcpServer.CallToolRequest['params']['arguments'] = {}, signal?: AbortSignal): Promise<mcpServer.CallToolResult> {
    if (name === browserSelectSchema.name)
      return this._select(args);
    if (name === browserExposeServiceSchema.name)
      return await this._exposeService(args);
    if (name === browserListServicesSchema.name)
      return this._listServices(args);
    if (name === browserCloseServiceSchema.name)
      return await this._closeService(args);
    const selected = this._selected;
    const state = this._availability[selected]();
    if (!state.available)
      return errorResult(`${state.label}不可用；当前选择未改变，请等待恢复或调用 browser_select 切换浏览器`);
    let activeBackend: ServerBackend | undefined;
    try {
      activeBackend = await this._backend(selected);
      const result = await activeBackend.callTool(name, args, signal ?? new AbortController().signal);
      if (result.isClose) {
        delete result.isClose;
        this._backends.delete(selected);
        await activeBackend.dispose?.().catch(() => {});
      }
      return result;
    } catch (error) {
      const promise = this._backends.get(selected);
      if (activeBackend && await promise?.catch(() => undefined) === activeBackend)
        this._backends.delete(selected);
      await activeBackend?.dispose?.().catch(() => {});
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }

  private async _backend(browser: BrowserId): Promise<ServerBackend> {
    let promise = this._backends.get(browser);
    if (!promise) {
      promise = (async () => {
        const backend = await this._factories[browser]();
        try {
          await backend.initialize?.(this._clientInfo!);
          return backend;
        } catch (error) {
          await backend.dispose?.().catch(() => {});
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

  private async _exposeService(rawArguments: mcpServer.CallToolRequest['params']['arguments']): Promise<mcpServer.CallToolResult> {
    if (!this._services || !this._clientInfo)
      return errorResult('服务转发未配置');
    const parsed = browserExposeServiceSchema.inputSchema.safeParse(rawArguments || {});
    if (!parsed.success)
      return errorResult(`browser_expose_service 参数无效：${z.prettifyError(parsed.error)}`);
    try {
      const value = await this._services.expose(this._clientInfo.scope, this._selected,
          this._taskId, parsed.data.port, parsed.data.lifetime as ServiceLifetime);
      return jsonResult(value);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }

  private _listServices(rawArguments: mcpServer.CallToolRequest['params']['arguments']): mcpServer.CallToolResult {
    if (!this._services || !this._clientInfo)
      return errorResult('服务转发未配置');
    const parsed = browserListServicesSchema.inputSchema.safeParse(rawArguments || {});
    if (!parsed.success)
      return errorResult(`browser_list_services 参数无效：${z.prettifyError(parsed.error)}`);
    try {
      return jsonResult({ services: this._services.list(this._clientInfo.scope, this._selected) });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }

  private async _closeService(rawArguments: mcpServer.CallToolRequest['params']['arguments']): Promise<mcpServer.CallToolResult> {
    if (!this._services || !this._clientInfo)
      return errorResult('服务转发未配置');
    const parsed = browserCloseServiceSchema.inputSchema.safeParse(rawArguments || {});
    if (!parsed.success)
      return errorResult(`browser_close_service 参数无效：${z.prettifyError(parsed.error)}`);
    try {
      await this._services.close(this._clientInfo.scope, this._selected, parsed.data.id);
      return jsonResult({ closed: true, id: parsed.data.id });
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }
}

function errorResult(message: string): mcpServer.CallToolResult {
  return { content: [{ type: 'text', text: `### Error\n${message}` }], isError: true };
}

function jsonResult(value: unknown): mcpServer.CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
