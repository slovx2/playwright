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
  private readonly _currentTabIds = new Map<BrowserId, string>();
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
      await backend?.callTool('browser_tabs', { action: 'finalize' }, new AbortController().signal).catch(() => {});
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
      return browserErrorResult({
        code: 'BROWSER_UNAVAILABLE',
        message: `${state.label}不可用；当前选择未改变`,
        recoverable: true,
        recoveryAction: '等待所选浏览器恢复；只有用户允许时才调用 browser_select 切换浏览器',
      }, selected, true, this._currentTabIds.get(selected));
    let activeBackend: ServerBackend | undefined;
    try {
      activeBackend = await this._backend(selected);
      const result = await activeBackend.callTool(name, args, signal ?? new AbortController().signal);
      const currentTabId = resultCurrentTabId(result);
      if (currentTabId)
        this._currentTabIds.set(selected, currentTabId);
      if (result.isError) {
        const failure = classifyBrowserError(resultText(result));
        if (result.isClose || !failure.recoverable) {
          this._backends.delete(selected);
          await activeBackend.dispose?.().catch(() => {});
        }
        return browserErrorResult(failure, selected, !result.isClose && failure.recoverable,
            this._currentTabIds.get(selected));
      }
      if (result.isClose) {
        delete result.isClose;
        this._backends.delete(selected);
        await activeBackend.dispose?.().catch(() => {});
      }
      return result;
    } catch (error) {
      const failure = classifyBrowserError(error instanceof Error ? error.message : String(error));
      if (!failure.recoverable) {
        const promise = this._backends.get(selected);
        if (activeBackend && await promise?.catch(() => undefined) === activeBackend)
          this._backends.delete(selected);
        await activeBackend?.dispose?.().catch(() => {});
      }
      return browserErrorResult(failure, selected, failure.recoverable,
          this._currentTabIds.get(selected));
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
      return browserErrorResult(classifyBrowserError(`browser_select 参数无效：${z.prettifyError(parsed.error)}`),
          this._selected, true, this._currentTabIds.get(this._selected));
    const target = parsed.data.browser as BrowserId | undefined;
    if (target) {
      const state = this._availability[target]();
      if (!state.available)
        return browserErrorResult({ code: 'BROWSER_UNAVAILABLE',
          message: `${state.label}当前不可用；当前选择未改变`, recoverable: true,
          recoveryAction: '等待显式选择的浏览器恢复，不要静默切换' },
        this._selected, true, this._currentTabIds.get(this._selected));
      this._selected = target;
    }
    const browsers = (['worker', 'desktop'] as const).map(id => ({ id, ...this._availability[id]() }));
    return {
      content: [{ type: 'text', text: JSON.stringify({ current: this._selected, browsers }, null, 2) }],
    };
  }

  private async _exposeService(rawArguments: mcpServer.CallToolRequest['params']['arguments']): Promise<mcpServer.CallToolResult> {
    if (!this._services || !this._clientInfo)
      return browserErrorResult(classifyBrowserError('服务转发未配置'), this._selected, true,
          this._currentTabIds.get(this._selected));
    const parsed = browserExposeServiceSchema.inputSchema.safeParse(rawArguments || {});
    if (!parsed.success)
      return browserErrorResult(classifyBrowserError(`browser_expose_service 参数无效：${z.prettifyError(parsed.error)}`),
          this._selected, true, this._currentTabIds.get(this._selected));
    try {
      const value = await this._services.expose(this._clientInfo.scope, this._selected,
          this._taskId, parsed.data.port, parsed.data.lifetime as ServiceLifetime);
      return jsonResult(value);
    } catch (error) {
      return browserErrorResult(classifyBrowserError(error instanceof Error ? error.message : String(error)),
          this._selected, true, this._currentTabIds.get(this._selected));
    }
  }

  private _listServices(rawArguments: mcpServer.CallToolRequest['params']['arguments']): mcpServer.CallToolResult {
    if (!this._services || !this._clientInfo)
      return browserErrorResult(classifyBrowserError('服务转发未配置'), this._selected, true,
          this._currentTabIds.get(this._selected));
    const parsed = browserListServicesSchema.inputSchema.safeParse(rawArguments || {});
    if (!parsed.success)
      return browserErrorResult(classifyBrowserError(`browser_list_services 参数无效：${z.prettifyError(parsed.error)}`),
          this._selected, true, this._currentTabIds.get(this._selected));
    try {
      return jsonResult({ services: this._services.list(this._clientInfo.scope, this._selected) });
    } catch (error) {
      return browserErrorResult(classifyBrowserError(error instanceof Error ? error.message : String(error)),
          this._selected, true, this._currentTabIds.get(this._selected));
    }
  }

  private async _closeService(rawArguments: mcpServer.CallToolRequest['params']['arguments']): Promise<mcpServer.CallToolResult> {
    if (!this._services || !this._clientInfo)
      return browserErrorResult(classifyBrowserError('服务转发未配置'), this._selected, true,
          this._currentTabIds.get(this._selected));
    const parsed = browserCloseServiceSchema.inputSchema.safeParse(rawArguments || {});
    if (!parsed.success)
      return browserErrorResult(classifyBrowserError(`browser_close_service 参数无效：${z.prettifyError(parsed.error)}`),
          this._selected, true, this._currentTabIds.get(this._selected));
    try {
      await this._services.close(this._clientInfo.scope, this._selected, parsed.data.id);
      return jsonResult({ closed: true, id: parsed.data.id });
    } catch (error) {
      return browserErrorResult(classifyBrowserError(error instanceof Error ? error.message : String(error)),
          this._selected, true, this._currentTabIds.get(this._selected));
    }
  }
}

function jsonResult(value: unknown): mcpServer.CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

type BrowserFailure = {
  code: string;
  message: string;
  recoverable: boolean;
  recoveryAction: string;
};

function classifyBrowserError(message: string): BrowserFailure {
  const normalized = message.toLowerCase();
  if (normalized.includes('control_interrupted') || normalized.includes('control was interrupted')) {
    return { code: 'BROWSER_CONTROL_INTERRUPTED', message, recoverable: true,
      recoveryAction: '调用 browser_tabs list，并使用新的 claimToken 显式认领用户标签页' };
  }
  if (normalized.includes('timed out') || normalized.includes('timeout') || normalized.includes('deadline')) {
    return { code: 'TOOL_TIMEOUT', message, recoverable: true,
      recoveryAction: '重新观察当前标签页并重试更窄的条件；不要重新选择浏览器' };
  }
  if (normalized.includes('cancelled') || normalized.includes('canceled') || normalized.includes('aborted')) {
    return { code: 'TOOL_CANCELLED', message, recoverable: true,
      recoveryAction: '确认任务仍需继续后，重新观察当前标签页' };
  }
  if (normalized.includes('disconnected')) {
    return { code: 'BROWSER_DISCONNECTED', message, recoverable: false,
      recoveryAction: '等待所选浏览器重新连接，然后重新开始浏览器会话' };
  }
  if (normalized.includes('incompatible') || normalized.includes('protocol version') ||
      normalized.includes('unsupported protocol') || normalized.includes('version mismatch')) {
    return { code: 'BROWSER_PROTOCOL_ERROR', message, recoverable: false,
      recoveryAction: '升级或恢复匹配版本的 Browser Bridge、Agent 与扩展' };
  }
  if (normalized.includes('context') && normalized.includes('closed')) {
    return { code: 'BROWSER_CONTEXT_CLOSED', message, recoverable: false,
      recoveryAction: '重新建立所选浏览器会话' };
  }
  return { code: 'BROWSER_TOOL_ERROR', message, recoverable: true,
    recoveryAction: '根据错误重新观察页面并修正参数；不要重复原失败定位器' };
}

function browserErrorResult(error: BrowserFailure, browser: BrowserId,
    sessionPreserved: boolean, currentTabId?: string): mcpServer.CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      error,
      browser,
      sessionPreserved,
      ...(currentTabId ? { currentTabId } : {}),
    }, null, 2) }],
    isError: true,
  };
}

function resultText(result: mcpServer.CallToolResult): string {
  return result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}

function resultCurrentTabId(result: mcpServer.CallToolResult): string | undefined {
  const text = resultText(result);
  const start = text.indexOf('{');
  if (start === -1)
    return;
  try {
    const value = JSON.parse(text.slice(start));
    return typeof value.currentTabId === 'string' ? value.currentTabId : undefined;
  } catch {
    return;
  }
}
