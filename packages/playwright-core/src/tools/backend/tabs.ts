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
    description: 'List, create, close, select, claim, or retain browser tabs. Controlled and user tabs are returned separately.',
    inputSchema: z.object({
      action: z.enum(['list', 'new', 'close', 'select', 'claim', 'mark_deliverable', 'mark_handoff', 'finalize']).describe('Operation to perform'),
      tabId: z.string().optional().describe('Stable controlled tab id used for close, select, and disposition actions.'),
      claimToken: z.string().uuid().optional().describe('Short-lived token returned for an unclaimed user tab.'),
      url: z.string().optional().describe('URL to navigate to in the new tab, used for new.'),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    switch (params.action) {
      case 'list':
        // Discover existing pages without creating a new tab.
        await context.refreshTabs();
        break;
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
        if (!params.tabId)
          throw new Error('tabId is required');
        await context.closeTab(params.tabId);
        break;
      }
      case 'select': {
        if (!params.tabId)
          throw new Error('tabId is required');
        await context.selectTab(params.tabId);
        break;
      }
      case 'claim': {
        if (!params.claimToken)
          throw new Error('claimToken is required');
        await context.claimTab(params.claimToken);
        break;
      }
      case 'mark_deliverable': {
        if (!params.tabId)
          throw new Error('tabId is required');
        context.markTab(params.tabId, 'deliverable');
        break;
      }
      case 'mark_handoff': {
        if (!params.tabId)
          throw new Error('tabId is required');
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
    const controlledTabs = tabHeaders.map((header, index) => {
      const tab = context.tabs()[index];
      const { id, ...rest } = header;
      return { tabId: id, ...rest, ...context.tabState(tab) };
    });
    const userTabs = params.action === 'list' ? await context.availableTabs() : [];
    response.addTextResult(JSON.stringify({
      session: context.sessionName(),
      currentTabId: context.currentTab()?.id,
      controlledTabs,
      userTabs,
    }, null, 2));
  },
});

export default [
  browserTabs,
];
