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
import { escapeWithQuotes } from '@isomorphic/stringUtils';

import { defineTabTool } from './tool';
import { elementSchema } from './snapshot';

const fillForm = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_fill_form',
    title: 'Fill form',
    description: 'Fill multiple form fields',
    inputSchema: z.object({
      fields: z.array(elementSchema.extend({
        name: z.string().describe('Human-readable field name'),
        type: z.enum(['textbox', 'checkbox', 'radio', 'combobox', 'slider']).describe('Type of the field'),
        value: z.string().describe('Value to fill in the field. If the field is a checkbox, the value should be `true` or `false`. If the field is a combobox, the value should be the text of the option.'),
      })).describe('Fields to fill in'),
    }),
    type: 'input',
  },

  handle: async (tab, params, response) => {
    const targets = await tab.targetLocators(params.fields.map(field => ({
      element: field.name,
      target: field.target,
    })));
    await Promise.all(params.fields.map(async (field, index) => {
      const locator = targets[index].locator;
      const control = await locator.evaluate(element => ({
        tag: element.tagName.toLowerCase(),
        type: element instanceof HTMLInputElement ? element.type.toLowerCase() : '',
        role: element.getAttribute('role')?.toLowerCase() || '',
        contentEditable: element instanceof HTMLElement && element.isContentEditable,
        options: element instanceof HTMLSelectElement ? [...element.options].map(option => option.label) : [],
      }));
      validateField(field, control);
    }));

    for (let index = 0; index < params.fields.length; index++) {
      const field = params.fields[index];
      const { locator, resolved } = targets[index];
      const locatorSource = `await page.${resolved}`;
      if (field.type === 'textbox' || field.type === 'slider') {
        const secret = tab.context.lookupSecret(field.value);
        await locator.fill(secret.value, tab.actionTimeoutOptions);
        response.addCode(`${locatorSource}.fill(${secret.code});`);
      } else if (field.type === 'checkbox' || field.type === 'radio') {
        await locator.setChecked(field.value === 'true', tab.actionTimeoutOptions);
        response.addCode(`${locatorSource}.setChecked(${field.value});`);
      } else if (field.type === 'combobox') {
        await locator.selectOption({ label: field.value }, tab.actionTimeoutOptions);
        response.addCode(`${locatorSource}.selectOption(${escapeWithQuotes(field.value)});`);
      }
    }
  },
});

type Field = {
  name: string;
  type: 'textbox' | 'checkbox' | 'radio' | 'combobox' | 'slider';
  value: string;
};

type Control = {
  tag: string;
  type: string;
  role: string;
  contentEditable: boolean;
  options: string[];
};

function validateField(field: Field, control: Control): void {
  const actual = control.role || control.type || control.tag;
  if (field.type === 'textbox') {
    const supported = control.tag === 'textarea' || control.contentEditable || control.role === 'textbox' ||
      (control.tag === 'input' && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(control.type));
    if (!supported)
      throw new Error(`${field.name} is ${actual}, not a textbox`);
    return;
  }
  if (field.type === 'checkbox' || field.type === 'radio') {
    if (!['true', 'false'].includes(field.value))
      throw new Error(`${field.name} requires value "true" or "false"`);
    if (control.type !== field.type && control.role !== field.type)
      throw new Error(`${field.name} is ${actual}, not a ${field.type}`);
    return;
  }
  if (field.type === 'slider') {
    if (control.type !== 'range' && control.role !== 'slider')
      throw new Error(`${field.name} is ${actual}, not a slider`);
    return;
  }
  if (control.tag !== 'select' && control.role !== 'combobox')
    throw new Error(`${field.name} is ${actual}, not a combobox`);
  if (control.tag === 'select' && !control.options.includes(field.value))
    throw new Error(`${field.name} does not contain option "${field.value}"`);
}

export default [
  fillForm,
];
