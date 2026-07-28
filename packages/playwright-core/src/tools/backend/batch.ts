/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import * as z from 'zod';

import { defineTool } from './tool';

export const batchToolNames = [
  'browser_navigate',
  'browser_navigate_back',
  'browser_navigate_forward',
  'browser_reload',
  'browser_click',
  'browser_drag',
  'browser_hover',
  'browser_select_option',
  'browser_type',
  'browser_press_key',
  'browser_fill_form',
  'browser_wait_for',
  'browser_handle_dialog',
  'browser_file_upload',
  'browser_tabs',
  'browser_snapshot',
  'browser_take_screenshot',
] as const;

export const browserBatch = defineTool({
  capability: 'core',
  schema: {
    name: 'browser_batch',
    title: 'Run browser actions',
    description: 'Run up to 20 structured browser actions sequentially. Stops at the first error. Include browser_snapshot or browser_take_screenshot only when an observation is needed.',
    inputSchema: z.object({
      actions: z.array(z.object({
        name: z.enum(batchToolNames).describe('Existing browser tool to invoke'),
        arguments: z.record(z.string(), z.unknown()).default({}).describe('Arguments for the selected tool'),
      })).min(1).max(20),
    }),
    type: 'action',
  },

  // BrowserBackend intercepts this tool so every step can reuse the normal
  // validation, response, cancellation and session-log path.
  handle: async () => {
    throw new Error('browser_batch must be executed by BrowserBackend');
  },
});

export default [
  browserBatch,
];
