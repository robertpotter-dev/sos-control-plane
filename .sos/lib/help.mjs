#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const libraryDir = dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, [join(libraryDir, '..', 'sos.mjs'), 'help'], { stdio: 'inherit' });

process.exitCode = result.status ?? 1;
