import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export const PLUGINS_DIR = '.sos/plugins';

export function pluginsRoot(repoRoot) {
    return join(repoRoot, PLUGINS_DIR);
}

function validateManifest(manifest, folderName) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error(`Plugin manifest in ${folderName} must be a JSON object.`);
    }
    if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
        throw new Error(`Plugin manifest in ${folderName} requires a non-empty "id".`);
    }
    if (!manifest.commands || typeof manifest.commands !== 'object' || Array.isArray(manifest.commands)) {
        throw new Error(`Plugin manifest in ${folderName} requires a "commands" object.`);
    }
    for (const [commandName, definition] of Object.entries(manifest.commands)) {
        if (!commandName.trim()) throw new Error(`Plugin ${manifest.id} declares an empty command name.`);
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
            throw new Error(`Plugin ${manifest.id} command "${commandName}" must be an object.`);
        }
        if (typeof definition.script !== 'string' || !definition.script.trim()) {
            throw new Error(`Plugin ${manifest.id} command "${commandName}" requires "script".`);
        }
        if (typeof definition.help !== 'string' || !definition.help.trim()) {
            throw new Error(`Plugin ${manifest.id} command "${commandName}" requires "help".`);
        }
    }
}

export function discoverPlugins(repoRoot) {
    const root = pluginsRoot(repoRoot);
    const plugins = [];
    const commands = new Map();
    if (!existsSync(root)) return { plugins, commands };

    for (const folderName of readdirSync(root).sort()) {
        if (folderName.startsWith('.')) continue;
        const pluginDir = join(root, folderName);
        if (!statSync(pluginDir).isDirectory()) continue;
        const manifestPath = join(pluginDir, 'plugin.json');
        if (!existsSync(manifestPath)) continue;

        let manifest;
        try {
            manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        } catch {
            throw new Error(`Invalid plugin manifest: ${manifestPath}`);
        }
        validateManifest(manifest, folderName);

        for (const [commandName, definition] of Object.entries(manifest.commands)) {
            if (commands.has(commandName)) {
                throw new Error(`Duplicate plugin command "${commandName}" declared by ${manifest.id}.`);
            }
            commands.set(commandName, {
                command: commandName,
                pluginId: manifest.id,
                pluginDir,
                script: definition.script,
                help: definition.help,
                supportsDryRun: Boolean(definition.supportsDryRun),
                nativeJson: definition.nativeJson !== false
            });
        }
        plugins.push({ id: manifest.id, folderName, pluginDir, manifest });
    }

    return { plugins, commands };
}

export function pluginOverviewLines(commands) {
    return [...commands.values()]
        .sort((a, b) => a.command.localeCompare(b.command))
        .map(entry => {
            const lines = entry.help.split('\n').map(line => line.trim()).filter(Boolean);
            const summary = lines.length > 1
                ? lines[1]
                : lines[0]?.replace(/^sos\s+\S+\s*/, '') || entry.command;
            return `  sos ${entry.command.padEnd(16)}${summary}`;
        });
}

export function appendPluginHelp(baseHelp, commands) {
    const lines = pluginOverviewLines(commands);
    if (!lines.length) return baseHelp;
    return `${baseHelp.replace('\nOutput controls:', `\nPlugins\n${lines.join('\n')}\n\nOutput controls:`)}`;
}
