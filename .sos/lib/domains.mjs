import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { parseFrontmatter } from './frontmatter.mjs';
import { canonicalDomainNamespace } from './identity.mjs';
import { resolveRepoRoot } from './root.mjs';

// SOS_ROOT remains the override. Walk from cwd when it exists; if cwd was
// deleted or is unreadable, fall back to this control-plane checkout.
export const REPO_ROOT = resolveRepoRoot({
    env: process.env,
    moduleUrl: import.meta.url
});

function toTitleCase(str) {
    return str.replace(/-/g, ' ').replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}

/**
 * Dynamically discovers all Domain Pillars by locating SPACE.md charters.
 * Returns an array of Domain objects:
 * {
 *   name: "personal",
 *   path: "<repo-root>/personal",
 *   prefix: "personal",
 *   exposure: "private",
 *   tier: 1, // 1: private, 2: restricted, 3: public
 *   spaceFile: "<repo-root>/personal/SPACE.md",
 *   title: "Personal Charter",
 *   vaultName: "Personal"
 * }
 */
export function discoverDomains(rootDir = REPO_ROOT) {
    const domains = [];
    const items = readdirSync(rootDir);
    for (const item of items) {
        if (item.startsWith('.') || item === 'node_modules' || item === 'assets' || item === 'inbox') continue;
        const itemPath = join(rootDir, item);
        try {
            if (statSync(itemPath).isDirectory()) {
                const spaceFile = join(itemPath, 'SPACE.md');
                if (existsSync(spaceFile)) {
                    const parsed = parseFrontmatter(readFileSync(spaceFile, 'utf-8'));
                    const prefix = canonicalDomainNamespace(item);
                    let exposure = 'standard';
                    let tier = 3;
                    let title = toTitleCase(item);

                    if (parsed?.exposure) {
                        exposure = parsed.exposure.toLowerCase();
                        if (exposure === 'private') tier = 1;
                        else if (exposure === 'restricted') tier = 2;
                        else tier = 3;
                    }
                    if (parsed?.title) title = parsed.title;
                    domains.push({ name: item, path: itemPath, prefix, exposure, tier, spaceFile, title, vaultName: toTitleCase(item) });
                }
            }
        } catch (e) {}
    }
    return domains;
}

export function getAllMarkdownFiles(dir) {
    let results = [];
    if (!existsSync(dir)) return results;
    const list = readdirSync(dir);
    for (const file of list) {
        if (file.startsWith('.') || file === 'node_modules' || file === 'inbox') continue;
        const fullPath = join(dir, file);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
            results = results.concat(getAllMarkdownFiles(fullPath));
        } else if (file.endsWith('.md')) {
            results.push(fullPath);
        }
    }
    return results;
}
