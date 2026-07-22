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

import { resolve } from 'path';
import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'icons/*',
          dest: 'icons'
        },
        {
          src: 'manifest.json',
          dest: '.'
        },
        {
          src: 'managed-storage-schema.json',
          dest: '.'
        }
      ]
    })
  ],
  root: resolve(__dirname),
  build: {
    outDir: resolve(__dirname, 'dist/'),
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/background.ts'),
      fileName: () => 'lib/background.mjs',
      formats: ['es']
    }
  }
});
