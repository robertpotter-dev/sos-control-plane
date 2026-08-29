import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

export const PLUGINS_DIR = '.sos/plugins';

export function pluginsRoot(repoRoot) {
    return join(repoRoot, PLUGINS_DIR);
}

function validatePluginScript(pluginDir, script, label) {
    const candidate = resolve(pluginDir, script);
    const rel = relative(pluginDir, candidate);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${label} script must stay inside its plugin directory: ${script}`);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) throw new Error(`${label} script does not exist: ${script}`);
}

function validateManifest(manifest, folderName) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
        throw new Error(`Plugin manifest in ${folderName} must be a JSON object.`);
    }
    if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
        throw new Error(`Plugin manifest in ${folderName} requires a non-empty "id".`);
    }
    const commands = manifest.commands ?? {};
    const sensors = manifest.sensors ?? {};
    if (typeof commands !== 'object' || Array.isArray(commands)) {
        throw new Error(`Plugin manifest in ${folderName} "commands" must be an object.`);
    }
    if (typeof sensors !== 'object' || Array.isArray(sensors)) {
        throw new Error(`Plugin manifest in ${folderName} "sensors" must be an object.`);
    }
    if (!Object.keys(commands).length && !Object.keys(sensors).length) {
        throw new Error(`Plugin manifest in ${folderName} requires at least one command or sensor.`);
    }
    for (const [commandName, definition] of Object.entries(commands)) {
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
    for (const [sensorId, definition] of Object.entries(sensors)) {
        if (!sensorId.trim()) throw new Error(`Plugin ${manifest.id} declares an empty sensor ID.`);
        if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
            throw new Error(`Plugin ${manifest.id} sensor "${sensorId}" must be an object.`);
        }
        if (typeof definition.script !== 'string' || !definition.script.trim()) {
            throw new Error(`Plugin ${manifest.id} sensor "${sensorId}" requires "script".`);
        }
        if (typeof definition.description !== 'string' || !definition.description.trim()) {
            throw new Error(`Plugin ${manifest.id} sensor "${sensorId}" requires "description".`);
        }
        if (!Array.isArray(definition.extensions) || !definition.extensions.length || definition.extensions.some(value => typeof value !== 'string' || !value.startsWith('.'))) {
            throw new Error(`Plugin ${manifest.id} sensor "${sensorId}" requires an "extensions" array of dotted file extensions.`);
        }
        if (definition.tags != null && (!Array.isArray(definition.tags) || definition.tags.some(value => typeof value !== 'string' || !value.trim()))) {
            throw new Error(`Plugin ${manifest.id} sensor "${sensorId}" tags must be non-empty strings.`);
        }
    }
}

export function discoverPlugins(repoRoot) {
    const root = pluginsRoot(repoRoot);
    const plugins = [];
    const commands = new Map();
    const sensors = [];
    const pluginIds = new Set();
    if (!existsSync(root)) return { plugins, commands, sensors };

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
        if (pluginIds.has(manifest.id)) {
            throw new Error(`Duplicate plugin id "${manifest.id}" in ${folderName}.`);
        }
        pluginIds.add(manifest.id);

        for (const [commandName, definition] of Object.entries(manifest.commands || {})) {
            validatePluginScript(pluginDir, definition.script, `Plugin ${manifest.id} command "${commandName}"`);
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
        for (const [sensorId, definition] of Object.entries(manifest.sensors || {})) {
            validatePluginScript(pluginDir, definition.script, `Plugin ${manifest.id} sensor "${sensorId}"`);
            sensors.push({
                sensorId,
                pluginId: manifest.id,
                pluginVersion: String(manifest.version || '0.0.0'),
                pluginDir,
                script: definition.script,
                description: definition.description,
                extensions: [...new Set(definition.extensions.map(value => value.toLowerCase()))],
                tags: [...new Set(definition.tags || [])],
                priority: Number(definition.priority) || 0
            });
        }
        plugins.push({ id: manifest.id, folderName, pluginDir, manifest });
    }

    return { plugins, commands, sensors };
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
