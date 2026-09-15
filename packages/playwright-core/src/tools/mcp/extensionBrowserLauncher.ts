/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { registry } from '../../server/registry';

export async function ensureExtensionBrowserRunning(channel: string, executablePath?: string): Promise<void> {
  const executable = executablePath ?? registry.findExecutable(channel)?.executablePathOrDie('javascript');
  if (!executable)
    throw new Error(`Browser channel "${channel}" is not installed`);
  const attempts = process.platform === 'linux' ? 3 : 1;
  let env: NodeJS.ProcessEnv | undefined;
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    const display = detectLinuxDisplayEnvironment();
    if (!display)
      throw new Error(`Browser channel "${channel}" has no DISPLAY`);
    env = { ...process.env, ...display };
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (process.platform === 'linux' && isExecutableRunning(executable))
      return;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, extensionBrowserLaunchArguments(), {
        detached: true,
        stdio: 'ignore',
        ...(env ? { env } : {}),
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
    if (process.platform !== 'linux')
      return;
    await new Promise(resolve => setTimeout(resolve, 2_000));
    if (isExecutableRunning(executable))
      return;
  }
  throw new Error(`Browser channel "${channel}" exited during startup`);
}

export function extensionBrowserLaunchArguments(platform: NodeJS.Platform = process.platform, uid = process.getuid?.()): string[] {
  return platform === 'linux' && uid === 0 ? ['--no-sandbox'] : [];
}

export function linuxDisplayNumber(display: string): string | undefined {
  return /^:(\d+)/.exec(display)?.[1];
}

export function pickLinuxDisplay(
  candidates: Array<{ DISPLAY: string; XAUTHORITY?: string }>,
  sockets: string[],
): { DISPLAY: string; XAUTHORITY?: string } | undefined {
  const socketSet = new Set(sockets);
  for (const candidate of candidates) {
    const number = linuxDisplayNumber(candidate.DISPLAY);
    if (!number || !socketSet.has(`X${number}`))
      continue;
    const selected: { DISPLAY: string; XAUTHORITY?: string } = { DISPLAY: `:${number}` };
    if (candidate.XAUTHORITY && path.isAbsolute(candidate.XAUTHORITY))
      selected.XAUTHORITY = candidate.XAUTHORITY;
    return selected;
  }
}

// systemd 没有 DISPLAY 时，从本机 X 服务器和同用户进程推断。
export function detectLinuxDisplayEnvironment(): { DISPLAY: string; XAUTHORITY?: string } | undefined {
  if (process.platform !== 'linux')
    return undefined;
  let sockets: string[] = [];
  try {
    sockets = fs.readdirSync('/tmp/.X11-unix');
  } catch {
    return undefined;
  }
  return pickLinuxDisplay(listLinuxDisplayCandidates(), sockets);
}

function listLinuxDisplayCandidates(): Array<{ DISPLAY: string; XAUTHORITY?: string }> {
  const uid = process.getuid?.();
  const fromXorg: Array<{ DISPLAY: string; XAUTHORITY?: string }> = [];
  const fromEnv: Array<{ DISPLAY: string; XAUTHORITY?: string }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name))
      continue;
    if (uid !== undefined && procUid(entry.name) !== uid)
      continue;
    const xorg = xorgDisplay(entry.name);
    if (xorg)
      fromXorg.push(xorg);
    const env = procEnviron(entry.name);
    if (env.DISPLAY)
      fromEnv.push({ DISPLAY: env.DISPLAY, XAUTHORITY: env.XAUTHORITY });
  }
  return [...fromXorg, ...fromEnv];
}

function procUid(pid: string): number | undefined {
  try {
    const line = fs.readFileSync(path.join('/proc', pid, 'status'), 'utf8').split('\n').find(value => value.startsWith('Uid:'));
    const effective = line?.trim().split(/\s+/)[2];
    return effective === undefined ? undefined : Number(effective);
  } catch {
    return undefined;
  }
}

function procEnviron(pid: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    for (const entry of fs.readFileSync(path.join('/proc', pid, 'environ')).toString('utf8').split('\0')) {
      const separator = entry.indexOf('=');
      if (separator > 0)
        env[entry.slice(0, separator)] = entry.slice(separator + 1);
    }
  } catch {
  }
  return env;
}

function procCmdline(pid: string): string[] {
  try {
    return fs.readFileSync(path.join('/proc', pid, 'cmdline'), 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function procCwd(pid: string): string | undefined {
  try {
    return fs.realpathSync.native(path.join('/proc', pid, 'cwd'));
  } catch {
    return undefined;
  }
}

function xorgDisplay(pid: string): { DISPLAY: string; XAUTHORITY?: string } | undefined {
  const argv = procCmdline(pid);
  if (!argv.some(value => /(^|\/)(Xorg|Xwayland|X)$/.test(value)))
    return undefined;
  const display = argv.find(value => /^:\d+/.test(value));
  if (!display)
    return undefined;
  const authIndex = argv.indexOf('-auth');
  let xauthority = authIndex >= 0 ? argv[authIndex + 1] : undefined;
  if (xauthority && !path.isAbsolute(xauthority)) {
    const cwd = procCwd(pid);
    xauthority = cwd ? path.resolve(cwd, xauthority) : undefined;
  }
  return { DISPLAY: display, XAUTHORITY: xauthority };
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
