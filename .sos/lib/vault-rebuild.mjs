import { existsSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';

export function resetCompiledVault(targetDir, { dryRun = false } = {}) {
    const removed = [];
    if (!existsSync(targetDir)) return removed;
    for (const entry of readdirSync(targetDir)) {
        if (entry === '.obsidian') continue;
        const path = join(targetDir, entry);
        if (entry === 'inbox') {
            const archive = join(path, 'archive');
            if (existsSync(archive)) {
                removed.push(archive);
                if (!dryRun) rmSync(archive, { recursive: true, force: true });
            }
            continue;
        }
        removed.push(path);
        if (!dryRun) rmSync(path, { recursive: true, force: true });
    }
    return removed;
}
