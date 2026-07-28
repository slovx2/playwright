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

const browserTabs = defineTool({
  capability: 'core-tabs',

  schema: {
    name: 'browser_tabs',
    title: 'Manage tabs',
    description: 'List, create, close, or select a browser tab.',
    inputSchema: z.object({
      action: z.enum(['list', 'new', 'close', 'select', 'claim', 'mark_deliverable', 'mark_handoff', 'finalize']).describe('Operation to perform'),
      index: z.number().optional().describe('Tab index, used for close/select. If omitted for close, current tab is closed.'),
      tabId: z.string().optional().describe('Stable tab id used for claim and disposition actions.'),
      title: z.string().optional().describe('Expected current tab title used for fail-closed claim.'),
      expectedUrl: z.string().optional().describe('Expected current tab URL used for fail-closed claim.'),
      url: z.string().optional().describe('URL to navigate to in the new tab, used for new.'),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    switch (params.action) {
      case 'list': {
        await context.ensureTab();
        break;
      }
      case 'new': {
        const tab = await context.newTab();
        if (params.url) {
          const url = await tab.checkUrlAndNavigate(params.url);
          response.setIncludeSnapshot();
          response.addCode(`await page.goto('${url}');`);
        }
        break;
      }
      case 'close': {
        await context.closeTab(params.index);
        break;
      }
      case 'select': {
        if (params.index === undefined)
          throw new Error('Tab index is required');
        await context.selectTab(params.index);
        break;
      }
      case 'claim': {
        if (!params.tabId || params.title === undefined || params.expectedUrl === undefined)
          throw new Error('tabId, title and expectedUrl are required');
        await context.claimTab(params.tabId, params.title, params.expectedUrl);
        break;
      }
      case 'mark_deliverable': {
        context.markTab(params.tabId, 'deliverable');
        break;
      }
      case 'mark_handoff': {
        context.markTab(params.tabId, 'handoff');
        break;
      }
      case 'finalize': {
        await context.finalizeTabs();
        response.setClose();
        break;
      }
    }
    const tabHeaders = await Promise.all(context.tabs().map(tab => tab.headerSnapshot()));
    const tabs = tabHeaders.map((header, index) => {
      const tab = context.tabs()[index];
      return { index, ...header, ...context.tabState(tab) };
    });
    if (params.action === 'list') {
      const available = await context.availableTabs();
      tabs.push(...available.map((tab, offset) => ({
        index: tabs.length + offset,
        ...tab,
      })));
    }
    response.addTextResult(JSON.stringify({ session: context.sessionName(), tabs }, null, 2));
  },
});

export default [
  browserTabs,
];
