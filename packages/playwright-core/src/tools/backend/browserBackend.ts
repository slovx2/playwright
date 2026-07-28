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
import debug from 'debug';
import { browserBatch } from './batch';
import { Context } from './context';
import { Response } from './response';
import { SessionLog } from './sessionLog';
import type { ContextConfig } from './context';
import type * as playwright from '../../..';
import type { Tool } from './tool';
import type * as mcpServer from '../utils/mcp/server';
import type { ClientInfo, ServerBackend } from '../utils/mcp/server';

export class BrowserBackend implements ServerBackend {
  private _tools: Tool[];
  private _context: Context | undefined;
  private _sessionLog: SessionLog | undefined;
  private _config: ContextConfig;
  private _disconnected = false;
  readonly browserContext: playwright.BrowserContext;

  constructor(config: ContextConfig, browserContext: playwright.BrowserContext, tools: Tool[]) {
    this._config = config;
    this._tools = tools;
    this.browserContext = browserContext;
    const markDisconnected = () => { this._disconnected = true; };
    this.browserContext.once('close', markDisconnected);
    this.browserContext.browser()?.once('disconnected', markDisconnected);
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this._sessionLog = this._config.saveSession ? await SessionLog.create(this._config, clientInfo.cwd) : undefined;
    this._context = new Context(this.browserContext, {
      config: this._config,
      sessionLog: this._sessionLog,
      cwd: clientInfo.cwd,
    });
  }

  async dispose() {
    await this._context?.dispose().catch(e => debug('pw:tools:error')(e));
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'] & { _meta?: Record<string, any> } = {}, signal?: AbortSignal): Promise<mcpServer.CallToolResult & { isClose?: boolean }> {
    if (name === browserBatch.schema.name)
      return await this._callBatch(rawArguments, signal);
    return await this._callSingleTool(name, rawArguments, signal);
  }

  private async _callBatch(rawArguments: mcpServer.CallToolRequest['params']['arguments'] & { _meta?: Record<string, any> }, signal?: AbortSignal): Promise<mcpServer.CallToolResult & { isClose?: boolean }> {
    const parsed = browserBatch.schema.inputSchema.safeParse(rawArguments);
    if (!parsed.success) {
      return {
        content: [{ type: 'text', text: `### Error\nInvalid arguments for tool "browser_batch":\n${z.prettifyError(parsed.error)}` }],
        isError: true,
      };
    }

    const summaries: Array<{ index: number, name: string, ok: boolean, text: string, timing?: unknown }> = [];
    const attachments: mcpServer.CallToolResult['content'] = [];
    let failed = false;
    let close = false;
    const startedAt = performance.now();
    for (let index = 0; index < parsed.data.actions.length; index++) {
      if (signal?.aborted)
        throw signal.reason ?? new Error('Browser batch was cancelled');
      const action = parsed.data.actions[index];
      const url = typeof action.arguments.url === 'string' ? action.arguments.url.trim() : '';
      if ((action.name === 'browser_navigate' || action.name === 'browser_tabs') && /^javascript:/i.test(url)) {
        summaries.push({ index, name: action.name, ok: false,
          text: 'javascript: URLs are not allowed in browser_batch' });
        failed = true;
        break;
      }
      const result = await this._callSingleTool(action.name, { ...action.arguments, _meta: rawArguments._meta }, signal);
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      summaries.push({ index, name: action.name, ok: !result.isError, text,
        timing: (result as any)._meta?.tyrsTiming });
      attachments.push(...result.content.filter(item => item.type !== 'text'));
      close ||= result.isClose === true;
      if (result.isError) {
        failed = true;
        break;
      }
      if (result.isClose)
        break;
    }

    const payload = {
      completed: summaries.filter(step => step.ok).length,
      failedAt: failed ? summaries.length - 1 : undefined,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      steps: summaries,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }, ...attachments],
      ...(failed ? { isError: true } : {}),
      ...(close ? { isClose: true } : {}),
    };
  }

  private async _callSingleTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'] & { _meta?: Record<string, any> } = {}, signal?: AbortSignal): Promise<mcpServer.CallToolResult & { isClose?: boolean }> {
    const json = !!rawArguments._meta?.json;
    const formatError = (message: string): mcpServer.CallToolResult => ({
      content: [{ type: 'text' as const, text: json ? JSON.stringify({ isError: true, error: message }, null, 2) : `### Error\n${message}` }],
      isError: true,
    });
    const tool = this._tools.find(tool => tool.schema.name === name)!;
    if (!tool)
      return formatError(`Tool "${name}" not found`);
    let parsedArguments: any;
    try {
      parsedArguments = tool.schema.inputSchema.parse(rawArguments);
    } catch (error) {
      if (error instanceof z.ZodError)
        return formatError(`Invalid arguments for tool "${name}":\n${z.prettifyError(error)}`);
      throw error;
    }
    const cwd = rawArguments._meta?.cwd;
    const raw = !!rawArguments._meta?.raw;
    const context = this._context!;
    const response = new Response(context, name, parsedArguments, { relativeTo: cwd, raw, json });
    context.setRunningTool(name);
    let responseObject: mcpServer.CallToolResult & { isClose?: boolean };
    const actionStartedAt = performance.now();
    let actionFinishedAt = actionStartedAt;
    try {
      await tool.handle(context, parsedArguments, response, signal);
      actionFinishedAt = performance.now();
      for (const reason of context.drainPendingUnhandledRejections())
        response.addError(formatRejectionReason(reason));
      responseObject = await response.serialize();
      (responseObject as any)._meta = {
        ...(responseObject as any)._meta,
        tyrsTiming: {
          pageActionMs: Math.round((actionFinishedAt - actionStartedAt) * 100) / 100,
          ...response.timings(),
          totalMs: Math.round((performance.now() - actionStartedAt) * 100) / 100,
        },
      };
      this._sessionLog?.logResponse(name, parsedArguments, responseObject);
    } catch (error: any) {
      const messages = [String(error), ...context.drainPendingUnhandledRejections().map(formatRejectionReason)];
      responseObject = formatError(messages.join('\n\n'));
    } finally {
      context.setRunningTool(undefined);
    }
    if (this._disconnected)
      responseObject.isClose = true;
    return responseObject;
  }
}

function formatRejectionReason(reason: unknown): string {
  if (reason instanceof Error)
    return reason.stack ?? reason.message;
  return String(reason);
}
