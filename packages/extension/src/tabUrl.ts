/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0.
 */

export function isDebuggableURL(value: string | undefined): boolean {
  if (!value)
    return false;
  if (/^about:blank(?:[?#].*)?$/i.test(value))
    return true;
  return !/^(about|chrome|chrome-extension|devtools|edge):/i.test(value);
}
