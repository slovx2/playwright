/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import * as z from 'zod';

import { defineTool } from './tool';

const sessionName = defineTool({
  capability: 'core-tabs',
  schema: {
    name: 'browser_session_name',
    title: 'Name browser session',
    description: 'Name the current browser session with a task-relevant emoji and short label.',
    inputSchema: z.object({
      name: z.string().trim().min(1).max(80),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    context.setSessionName(params.name);
    response.addTextResult(`Browser session named ${params.name}`);
  },
});

const visibility = defineTool({
  capability: 'core-tabs',
  schema: {
    name: 'browser_visibility',
    title: 'Show browser tab',
    description: 'Show the controlled Chrome tab only when the user explicitly asks to watch or take over. visible=false keeps background execution and does not change focus.',
    inputSchema: z.object({
      visible: z.boolean(),
      tabId: z.string().optional(),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    if (params.visible)
      await context.showTab(params.tabId);
    response.addTextResult(params.visible ? 'Browser tab is visible' : 'Browser remains in the background');
  },
});

export default [
  sessionName,
  visibility,
];
