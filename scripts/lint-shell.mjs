#!/usr/bin/env node
// Author: Bishop Crockett
// Owner: Argellan.com
// License: MIT
// SPDX-License-Identifier: MIT
// Attribution covers ARGELLAN-authored implementation and modifications only.
// Upstream credits and licenses remain in THIRD_PARTY_NOTICES.md.
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
for await (const name of fs.glob('deploy/**/*.sh', { cwd: root })) files.push(name);
const result = spawnSync(process.env.SHELLCHECK || 'shellcheck', ['--shell=sh', ...files.sort()], { cwd: root, stdio: 'inherit', windowsHide: true, shell: false });
if (result.error) console.error('ShellCheck is unavailable. Install the pinned development tool or set SHELLCHECK to its executable path.');
process.exitCode = result.status ?? 1;
