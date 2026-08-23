import { existsSync, readFileSync } from 'fs';

import { parseFrontmatter, splitFrontmatter } from './frontmatter.mjs';

export function compiledFromValue(content) {
    const parsed = parseFrontmatter(content);
    if (!parsed?.yaml) return null;
    const match = parsed.yaml.match(/^compiled_from:\s*(.*)$/m);
    if (!match) return null;
    const raw = match[1].trim();
    if (!raw) return null;
    return raw.replace(/^["']|["']$/g, '').trim() || null;
}

export function stampCompiledFrom(content, label) {
    const split = splitFrontmatter(content);
    if (!split) return content;
    const yaml = split.yaml.replace(/^compiled_from:\s*.*\r?\n?/m, '');
    return `---\ncompiled_from: ${JSON.stringify(label)}\n${yaml}\n---${split.body}`;
}

export function readVaultOwner(charterPath) {
    if (!existsSync(charterPath)) return { exists: false, owner: null };
    const owner = compiledFromValue(readFileSync(charterPath, 'utf-8'));
    return { exists: true, owner };
}

export function vaultOwnershipConflict({ destCharterPath, instanceLabel, vaultName }) {
    const { exists, owner } = readVaultOwner(destCharterPath);
    if (!exists) return null;
    if (owner && owner === instanceLabel) return null;
    if (owner) {
        return {
            kind: 'foreign',
            owner,
            vaultName,
            destCharterPath,
            message: `Vault "${vaultName}" already exists under a different system "${owner}".`
        };
    }
    return {
        kind: 'unstamped',
        owner: null,
        vaultName,
        destCharterPath,
        message: `Vault "${vaultName}" already exists and has no system stamp.`
    };
}

export function formatVaultOwnershipFailure(conflicts) {
    const lines = ['Sync stopped. Nothing was overwritten.', ''];
    for (const conflict of conflicts) {
        lines.push(conflict.message);
    }
    lines.push('');
    lines.push('Cancel and fix the destination yourself or with your agent.');
    lines.push('Overwrite is not recommended: sos sync --force');
    return lines.join('\n');
}
