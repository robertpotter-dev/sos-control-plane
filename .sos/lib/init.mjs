import { mkdirSync, writeFileSync } from 'fs';
import { basename, join, relative } from 'path';

import { fail } from './cli.mjs';
import { localDateString } from './debrief.mjs';
import {
    configuredMirrors,
    configuredSystemName,
    configuredVaults,
    readSystemConfig,
    relocateLegacySystemConfig,
    SYSTEM_CONFIG_RELATIVE_PATH,
    updateSystemConfig,
    writeSystemConfig
} from './system-config.mjs';
import { ui } from './terminal.mjs';

export const INIT_CHARTER_PLACEHOLDER = 'This domain was created by sos init. Charter it in debrief before minting notes.';

function mintDomain(repoRoot, domain) {
    const prefix = domain.name.replace(/[^a-z0-9]/g, '').slice(0, 4) || 'node';
    const domainPath = join(repoRoot, domain.name);
    const title = domain.name.replace(/\b\w/g, char => char.toUpperCase());
    mkdirSync(join(domainPath, 'assets'), { recursive: true });
    mkdirSync(join(domainPath, 'inbox', 'archive'), { recursive: true });
    const charter = [
        '---',
        `id: "${prefix}:charter"`,
        `parent: "${prefix}:charter"`,
        'related: []',
        `title: "${title} Charter"`,
        `description: "Foundational charter for the ${domain.name} domain."`,
        'type: "charter"',
        `domain: "${domain.name}"`,
        `exposure: "${domain.exposure}"`,
        'status: "active"',
        `created: ${localDateString()}`,
        `updated: ${localDateString()}`,
        `tags: ["${domain.name}", "charter"]`,
        '---',
        '',
        `# ${title}`,
        '',
        INIT_CHARTER_PLACEHOLDER,
        ''
    ].join('\n');
    writeFileSync(join(domainPath, 'SPACE.md'), charter, { encoding: 'utf-8', flag: 'wx' });
}

export function initCommand(args, options, ctx) {
    const { repoRoot, discoverDomains } = ctx;
    if (options.dryRun) return fail('--dry-run is not applicable to init.', options);
    let name = null;
    let vault = null;
    let mirror = null;
    const domains = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--name') {
            name = args[++index];
            if (!name) return fail('--name requires a system name.', options);
        } else if (arg === '--vault') {
            vault = args[++index];
            if (!vault) return fail('--vault requires a path.', options);
        } else if (arg === '--mirror') {
            mirror = args[++index];
            if (!mirror) return fail('--mirror requires a path.', options);
        } else if (arg === '--domain') {
            const value = args[++index];
            if (!value) return fail('--domain requires name:exposure, e.g. research:public.', options);
            const [domainName, exposure] = value.split(':');
            if (!/^[a-z0-9][a-z0-9-]*$/.test(domainName || '')) return fail(`Invalid domain name: ${domainName || value}`, options);
            if (!['private', 'restricted', 'public'].includes(exposure)) return fail(`Domain exposure must be private, restricted, or public: ${value}`, options);
            domains.push({ name: domainName, exposure });
        } else {
            return fail(`Unknown init option: ${arg}`, options);
        }
    }

    if (!name && !domains.length) {
        return fail('init requires --domain name:exposure. Optional --name writes a dashboard label to .sos/config.json.', options);
    }

    const config = readSystemConfig(repoRoot);
    if (config.invalid) return fail(`${config.relativePath} is not valid JSON.`, options);
    const existingName = typeof config.data.systemName === 'string' && config.data.systemName.trim()
        ? config.data.systemName
        : null;
    if (name && existingName) {
        return fail('System name is already set. Init will not rename it. Add domains with sos init --domain name:exposure.', options);
    }

    const knownDomains = new Set(discoverDomains().map(domain => domain.name));
    for (const domain of domains) {
        if (knownDomains.has(domain.name)) return fail(`Domain already exists: ${domain.name}`, options);
        if (domains.filter(candidate => candidate.name === domain.name).length > 1) return fail(`Duplicate --domain value: ${domain.name}`, options);
    }

    let createdConfig = false;
    let labeled = false;
    const added = [];
    if (name && !config.exists) {
        writeSystemConfig(repoRoot, {
            systemName: name,
            created: localDateString(),
            vaults: vault ? [vault] : [],
            mirrors: mirror ? [mirror] : []
        });
        createdConfig = true;
        labeled = true;
        if (vault) added.push(`vault ${vault}`);
        if (mirror) added.push(`mirror ${mirror}`);
    } else {
        relocateLegacySystemConfig(repoRoot);
        const updates = {};
        if (name && !existingName) {
            updates.systemName = name;
            labeled = true;
        }
        if (vault) {
            const current = configuredVaults(repoRoot);
            if (!current.includes(vault)) {
                updates.vaults = [...current, vault];
                added.push(`vault ${vault}`);
            }
        }
        if (mirror) {
            const current = configuredMirrors(repoRoot);
            if (!current.includes(mirror)) {
                updates.mirrors = [...current, mirror];
                added.push(`mirror ${mirror}`);
            }
        }
        if (Object.keys(updates).length) updateSystemConfig(repoRoot, updates);
    }
    for (const domain of domains) mintDomain(repoRoot, domain);

    const systemName = name || existingName || configuredSystemName(repoRoot) || basename(repoRoot);
    const result = {
        ok: true,
        config: SYSTEM_CONFIG_RELATIVE_PATH,
        systemName,
        createdConfig,
        domains
    };
    if (options.json) return console.log(JSON.stringify(result, null, 2));
    if (options.quiet) return;
    const parts = [];
    if (labeled) parts.push(`Labeled ${systemName} in ${relative(repoRoot, join(repoRoot, SYSTEM_CONFIG_RELATIVE_PATH))}.`);
    if (added.length) parts.push(`Configured ${added.join(' and ')}.`);
    if (domains.length) parts.push(`Created ${domains.length} domain charter(s).`);
    console.log(ui.success(parts.join(' ') || `Labeled ${systemName}.`));

    const vaults = configuredVaults(repoRoot);
    const mirrors = configuredMirrors(repoRoot);
    if (!vaults.length || !mirrors.length) {
        console.log('');
        console.log(ui.warning('Next Steps:'));
        console.log(ui.muted('  Vaults and mirrors are optional. A vault is the parent of compiled domain folders:'));
        if (!vaults.length) console.log(ui.muted('  $ sos config add vault /path/to/parent'));
        if (!mirrors.length) console.log(ui.muted('  $ sos config add mirror /path/to/backup'));
    }
}
