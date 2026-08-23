import { readSystemConfig, updateSystemConfig, SYSTEM_CONFIG_RELATIVE_PATH, configuredVaults, configuredMirrors } from './system-config.mjs';
import { fail } from './cli.mjs';
import { ui } from './terminal.mjs';

export function configCommand(args, options, ctx) {
    const { repoRoot } = ctx;
    const action = args[0] || 'list';

    if (action === 'list') {
        console.log(ui.heading(`Current Configuration (${SYSTEM_CONFIG_RELATIVE_PATH}):`));

        const vaults = configuredVaults(repoRoot);
        if (vaults.length > 0) {
            console.log(ui.success('  Vault Targets:'));
            for (const v of vaults) {
                console.log(`    - ${v}`);
            }
        } else {
            console.log(ui.warning('  No vault targets configured.'));
            console.log(ui.muted('  Add one: sos config add vault <path>'));
        }

        console.log('');

        const mirrors = configuredMirrors(repoRoot);
        if (mirrors.length > 0) {
            console.log(ui.success('  Mirror Targets:'));
            for (const m of mirrors) {
                console.log(`    - ${m}`);
            }
        } else {
            console.log(ui.warning('  No mirror targets configured.'));
            console.log(ui.muted('  Add one: sos config add mirror <path>'));
        }
        return;
    }

    if (args.length < 3) {
        return fail(`Usage: sos config ${action} [vault | mirror] <path>`, options);
    }

    const key = args[1];
    const value = args[2];

    if (action === 'add') {
        if (key === 'vault' || key === 'vaults') {
            const current = configuredVaults(repoRoot);
            if (!current.includes(value)) {
                updateSystemConfig(repoRoot, { vaults: [...current, value] });
            }
            console.log(ui.success(`Added vault target: ${value}`));
        } else if (key === 'mirror' || key === 'mirrors') {
            const current = configuredMirrors(repoRoot);
            if (!current.includes(value)) {
                updateSystemConfig(repoRoot, { mirrors: [...current, value] });
            }
            console.log(ui.success(`Added mirror target: ${value}`));
        } else {
            return fail(`Unknown key: ${key}`, options);
        }
    } else if (action === 'remove') {
        if (key === 'vault' || key === 'vaults') {
            const current = configuredVaults(repoRoot);
            updateSystemConfig(repoRoot, { vaults: current.filter(v => v !== value) });
            console.log(ui.success(`Removed vault target: ${value}`));
        } else if (key === 'mirror' || key === 'mirrors') {
            const current = configuredMirrors(repoRoot);
            updateSystemConfig(repoRoot, { mirrors: current.filter(m => m !== value) });
            console.log(ui.success(`Removed mirror target: ${value}`));
        } else {
            return fail(`Unknown key: ${key}`, options);
        }
    } else {
        return fail(`Unknown config action: ${action}. Use list, add, or remove.`, options);
    }
}
