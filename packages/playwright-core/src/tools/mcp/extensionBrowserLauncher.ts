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

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { registry } from '../../server/registry';

export async function ensureExtensionBrowserRunning(channel: string, executablePath?: string): Promise<void> {
  const executable = executablePath ?? registry.findExecutable(channel)?.executablePathOrDie('javascript');
  if (!executable)
    throw new Error(`Browser channel "${channel}" is not installed`);
  if (process.platform === 'linux' && isExecutableRunning(executable))
    return;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, extensionBrowserLaunchArguments(), { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function extensionBrowserLaunchArguments(platform: NodeJS.Platform = process.platform, uid = process.getuid?.()): string[] {
  return platform === 'linux' && uid === 0 ? ['--no-sandbox'] : [];
}

function isExecutableRunning(executablePath: string): boolean {
  let expected: string;
  try {
    expected = fs.realpathSync.native(executablePath);
  } catch {
    return false;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name))
      continue;
    try {
      if (fs.realpathSync.native(path.join('/proc', entry.name, 'exe')) === expected)
        return true;
    } catch {
    }
  }
  return false;
}
