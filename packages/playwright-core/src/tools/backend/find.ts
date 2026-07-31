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

import { defineTabTool } from './tool';

// Number of context lines to show around each match, like `grep -C`.
const contextLines = 3;

const find = defineTabTool({
  capability: 'core',
  schema: {
    name: 'browser_find',
    title: 'Find in page snapshot',
    description: 'Search the accessibility snapshot of the current page for text or a regular expression. Returns matching snapshot nodes with a few lines of surrounding context (like search snippets), each shown under its path from the root of the tree, which is cheaper than capturing the whole snapshot when you only need to locate an element and its ref.',
    inputSchema: z.object({
      text: z.string().optional().describe('Plain text to search for in the page snapshot (case-insensitive substring match). Provide either text or regex, not both.'),
      regex: z.string().optional().refine(v => !v || isValidRegex(v), { message: 'Invalid regular expression' }).describe('Regular expression to search for in the page snapshot. Matching is case-sensitive by default; wrap the pattern in slashes to add flags, e.g. "/error/i" for case-insensitive. Provide either text or regex, not both.'),
      exact: z.boolean().optional().default(false).describe('For text search, require a case-insensitive whole-line match.'),
      limit: z.number().int().min(1).max(100).optional().default(20).describe('Maximum number of matches to return.'),
    }),
    type: 'readOnly',
  },

  handle: async (tab, params, response) => {
    if (!params.text && !params.regex) {
      response.addError('Provide either "text" or "regex" to search for.');
      return;
    }
    if (params.text && params.regex) {
      response.addError('Provide only one of "text" or "regex", not both.');
      return;
    }

    let query: string;
    let matches: (line: string) => boolean;
    if (params.regex) {
      const re = compileRegex(params.regex);
      query = String(re);
      matches = line => {
        re.lastIndex = 0;
        return re.test(line);
      };
    } else {
      query = `"${params.text}"`;
      const needle = params.text!.toLowerCase();
      matches = line => params.exact ? line.trim().toLowerCase() === needle : line.toLowerCase().includes(needle);
    }

    const snapshot = await tab.page.ariaSnapshot({ mode: 'ai' });
    const lines = snapshot.split('\n');
    const indents = lines.map(indentOf);
    const matchedLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (matches(lines[i]))
        matchedLines.push(i);
    }

    if (!matchedLines.length) {
      response.addTextResult(`No matches found for ${query}.`);
      return;
    }

    // Merge matched lines into windows of context, coalescing overlapping ones.
    const returnedLines = matchedLines.slice(0, params.limit);
    const windows = returnedLines.map(line => ({
      start: Math.max(0, line - contextLines),
      end: Math.min(lines.length - 1, line + contextLines),
      match: line,
    }));

    const path = new Set<number>();
    for (const match of matchedLines) {
      path.add(match);
      for (const ancestor of ancestorIndices(lines, indents, match))
        path.add(ancestor);
    }

    const snippets = windows.map(window => {
      const indices = ancestorIndices(lines, indents, window.start);
      for (let i = window.start; i <= window.end; i++)
        indices.push(i);
      const out: string[] = [];
      for (let i = 0; i < indices.length; i++) {
        const index = indices[i];
        if (i > 0 && index > indices[i - 1] + 1 && !path.has(index) && !path.has(indices[i - 1]))
          out.push(' '.repeat(indents[index]) + '...');
        out.push(lines[index]);
      }
      const snippet = out.join('\n');
      return {
        line: window.match + 1,
        refs: [...snippet.matchAll(/\b(?:ref=)?((?:f\d+)?e\d+)\b/g)].map(match => match[1]),
        snippet,
      };
    });
    const matchWord = matchedLines.length === 1 ? 'match' : 'matches';
    const structured = JSON.stringify({
      query,
      total: matchedLines.length,
      returned: returnedLines.length,
      truncated: matchedLines.length > returnedLines.length,
      matches: snippets,
    }, null, 2);
    response.addTextResult(`Found ${matchedLines.length} ${matchWord} for ${query}:\n\n` +
      `${snippets.map(match => match.snippet).join('\n\n----\n\n')}\n\nStructured matches:\n${structured}`);
  },
});

function compileRegex(source: string): RegExp {
  const literal = /^\/(.*)\/([a-z]*)$/.exec(source);
  const pattern = literal ? literal[1] : source;
  const flags = literal ? literal[2].replace(/g/g, '') : '';
  return new RegExp(pattern, flags);
}

function isValidRegex(source: string): boolean {
  try {
    compileRegex(source);
    return true;
  } catch {
    return false;
  }
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function ancestorIndices(lines: string[], indents: number[], index: number): number[] {
  const result: number[] = [];
  let indent = indents[index];
  for (let i = index - 1; i >= 0 && indent > 0; i--) {
    if (!lines[i].trim())
      continue;
    if (indents[i] < indent) {
      result.push(i);
      indent = indents[i];
    }
  }
  return result.reverse();
}

export default [
  find,
];
