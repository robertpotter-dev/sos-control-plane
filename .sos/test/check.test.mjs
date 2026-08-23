import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test('the complete control plane lives under the hidden .sos root', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

    assert.equal(packageJson.bin.sos, '.sos/sos.mjs');
    assert.equal(existsSync(join(root, '.sos', 'sos.mjs')), true);
    assert.equal(existsSync(join(root, '.sos', 'lib', 'domains.mjs')), true);
    assert.equal(existsSync(join(root, '.sos', 'test', 'check.test.mjs')), true);
    assert.equal(existsSync(join(root, 'bin')), false);
    assert.equal(existsSync(join(root, '.tooling')), false);
    assert.equal(existsSync(join(root, 'test')), false);
    assert.equal(existsSync(join(root, 'sos.config.json')), false);
});

test('sos.mjs dispatches in-process dashboard commands without inlined collectors', () => {
    const source = readFileSync(join(root, '.sos', 'sos.mjs'), 'utf-8');
    assert.match(source, /statusCommand\(args, options, ctx\)/);
    assert.match(source, /inboxCommand\(args, options, ctx\)/);
    assert.match(source, /doctorCommand\(args, options, ctx\)/);
    assert.match(source, /initCommand\(args, options, ctx\)/);
    assert.doesNotMatch(source, /function collectTierOneNodes/);
    assert.doesNotMatch(source, /function scanInboxes/);
});

test('check is limited to format, lint, and audit', () => {
    const source = readFileSync(join(root, '.sos', 'lib', 'pipeline.mjs'), 'utf-8');
    const stageScripts = [...source.matchAll(/script: '([^']+)'/g)].map(match => match[1]);

    assert.deepEqual(stageScripts, ['format.mjs', 'lint.mjs', 'audit.mjs']);
    assert.doesNotMatch(source, /sync\.mjs|readline|git add|git commit/i);
    assert.match(source, /ui\.option\('RUN'\)/);
    assert.match(source, /ui\.success\('PASS'\)/);
});

test('format excludes deterministic evidence, inbox custody, and generated control-plane state', () => {
    const source = readFileSync(join(root, '.sos', 'lib', 'format.mjs'), 'utf-8');

    assert.match(source, /file === 'inbox' \|\| file === 'assets' \|\| file === 'cache' \|\| file === 'runtime' \|\| file === 'vendor'/);
});

test('git hooks format before the snapshot and sync without formatting after it', () => {
    const pre = readFileSync(join(root, '.sos', 'hooks', 'pre-commit'), 'utf-8');
    const post = readFileSync(join(root, '.sos', 'hooks', 'post-commit'), 'utf-8');

    assert.match(pre, /format\.mjs/);
    assert.match(pre, /lint\.mjs/);
    assert.match(pre, /audit\.mjs/);
    assert.match(pre, /git add -- "\$file"/);
    assert.match(post, /sync\.mjs" --quick/);
    assert.doesNotMatch(post, /sync\.mjs" > /);
});

test('audit and sync use the shared semantic terminal palette', () => {
    const audit = readFileSync(join(root, '.sos', 'lib', 'audit.mjs'), 'utf-8');
    const sync = readFileSync(join(root, '.sos', 'lib', 'sync.mjs'), 'utf-8');

    assert.match(audit, /ui\.option\(`\[\$\{e\.from\}\]`\)/);
    assert.match(audit, /ui\.success\('PASS  Graph structure, IFC, evidence lineage, and operator preferences are intact\.'\)/);
    assert.match(sync, /ui\.option\('DRY RUN'\)/);
    assert.match(sync, /ui\.warning\(dryRun \? 'WOULD REMOVE' : 'REMOVED'\)/);
    assert.match(sync, /ui\.success\('SYNC COMPLETE'\)/);
    assert.ok(sync.includes('`${relatedReplacement}\\n`'));
    assert.match(sync, /return `  - "\$\{destination\}"`/);
    assert.match(sync, /--delete --delete-excluded/);
    assert.match(sync, /--exclude="\.sos\/cache" --exclude="\.sos\/runtime"/);
    assert.match(sync, /stdio: json \? 'ignore' : 'inherit'/);
    assert.match(sync, /copyUnchanged/);
    assert.match(sync, /syncStats\.textSkips/);
    assert.match(sync, /inbox\/archive/);
    assert.match(sync, /vault-manifest/);
    assert.match(sync, /--rebuild/);
    assert.match(sync, /--force/);
    assert.match(sync, /resetCompiledVault/);
    assert.match(sync, /vaultOwnershipConflict/);
    assert.match(sync, /entry === 'inbox' \|\| entry === '\.obsidian'/);
    assert.match(sync, /CURRENT_VAULT_TARGET/);
    assert.doesNotMatch(sync, /OBSIDIAN_TARGET/);
});

function checkFixture() {
    const fixture = mkdtempSync(join(os.tmpdir(), 'sos-check-json-'));
    mkdirSync(join(fixture, 'journal'), { recursive: true });
    writeFileSync(join(fixture, 'journal', 'SPACE.md'), [
        '---',
        'id: "jrnl:charter"',
        'parent: "jrnl:charter"',
        'related: []',
        'title: "Journal Charter"',
        'description: "Fixture charter."',
        'type: "charter"',
        'domain: "journal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-17',
        'updated: 2026-08-17',
        'tags: ["test"]',
        '---',
        '',
        '# Journal Charter',
        '',
        'Fixture.',
        ''
    ].join('\n'), 'utf-8');
    return fixture;
}

test('sos check --json emits per-stage results without wrapping stdout', () => {
    const fixture = checkFixture();
    const result = spawnSync(process.execPath, [join(root, '.sos', 'sos.mjs'), 'check', '--json'], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: fixture, SOS_OBSIDIAN_ROOT: '/tmp', NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.command, undefined);
    assert.equal(payload.stdout, undefined);
    assert.deepEqual(payload.stages.map(stage => stage.name), ['Format', 'Lint', 'Audit']);
    assert.equal(payload.ok, true, result.stderr || result.stdout);
    assert.equal(result.status, 0);
    assert.equal(existsSync(join(fixture, '.sos', 'cache', 'graph-index.json')), true);
});

test('sos help config documents add/remove and not set or edit', () => {
    const result = spawnSync(process.execPath, [join(root, '.sos', 'sos.mjs'), 'help', 'config'], {
        cwd: root,
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sos config add vault/);
    assert.match(result.stdout, /sos config add mirror/);
    assert.match(result.stdout, /sos config remove vault/);
    assert.doesNotMatch(result.stdout, /sos config set /);
    assert.doesNotMatch(result.stdout, /sos config edit/);
});

test('sos -v prints version; sos sync -v selects vaults', () => {
    const version = spawnSync(process.execPath, [join(root, '.sos', 'sos.mjs'), '-v'], {
        cwd: root,
        encoding: 'utf-8'
    });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);

    const fixture = checkFixture();
    const result = spawnSync(process.execPath, [join(root, '.sos', 'sos.mjs'), 'sync', '-v', '--json', '--dry-run', '--quick'], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: fixture, SOS_OBSIDIAN_ROOT: '/tmp', NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.vaults, true);
    assert.equal(payload.mirrors, false);
    assert.equal(payload.version, undefined);
});

test('sos config with no args lists targets', () => {
    const fixture = checkFixture();
    mkdirSync(join(fixture, '.sos'), { recursive: true });
    writeFileSync(join(fixture, '.sos', 'config.json'), `${JSON.stringify({ version: 1, vaults: ['/tmp/vault'], mirrors: [] }, null, 2)}\n`);
    const result = spawnSync(process.execPath, [join(root, '.sos', 'sos.mjs'), 'config'], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: fixture, NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Vault Targets/);
    assert.match(result.stdout, /\/tmp\/vault/);
});

test('sos sync --json --dry-run --quick succeeds with no vaults and no mirrors', () => {
    const fixture = checkFixture();
    mkdirSync(join(fixture, '.sos'), { recursive: true });
    writeFileSync(join(fixture, '.sos', 'config.json'), '{"version":1,"vaults":[],"mirrors":[]}\n');
    const env = { ...process.env, SOS_ROOT: fixture, NO_COLOR: '1' };
    delete env.SOS_OBSIDIAN_ROOT;
    const result = spawnSync(process.execPath, [join(root, '.sos', 'sos.mjs'), 'sync', '--json', '--dry-run', '--quick'], {
        cwd: root,
        env,
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.planned.backupRuns, 0);
});

test('sos sync --vaults fails when none are configured', () => {
    const fixture = checkFixture();
    mkdirSync(join(fixture, '.sos'), { recursive: true });
    writeFileSync(join(fixture, '.sos', 'config.json'), '{"version":1,"vaults":[],"mirrors":[]}\n');
    const env = { ...process.env, SOS_ROOT: fixture, NO_COLOR: '1' };
    delete env.SOS_OBSIDIAN_ROOT;
    const result = spawnSync(process.execPath, [join(root, '.sos', 'sos.mjs'), 'sync', '--json', '--dry-run', '--quick', '--vaults'], {
        cwd: root,
        env,
        encoding: 'utf-8'
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /No vault targets configured/);
});

test('sos sync --json --dry-run emits planned counts without the per-file log', () => {
    const fixture = checkFixture();
    const result = spawnSync(process.execPath, [join(root, '.sos', 'sos.mjs'), 'sync', '--json', '--dry-run', '--quick', '--mirrors'], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: fixture, SOS_OBSIDIAN_ROOT: '/tmp', NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.quick, true);
    assert.equal(payload.mirrors, true);
    assert.equal(payload.vaults, false);
    assert.equal(payload.planned.backupRuns, 0);
    assert.equal(payload.stdout, undefined);
    assert.doesNotMatch(result.stdout, /SYNC COMPLETE|WOULD MIRROR/);
    assert.equal(existsSync(join(fixture, '.sos', 'cache', 'graph-index.json')), false);
});

test('sos sync --json preflight failure includes the native audit payload', () => {
    const fixture = checkFixture();
    mkdirSync(join(fixture, '.sos'), { recursive: true });
    writeFileSync(join(fixture, '.sos', 'operator-preferences.json'), '{', 'utf-8');
    const result = spawnSync(process.execPath, [join(root, '.sos', 'sos.mjs'), 'sync', '--json', '--dry-run', '--vaults'], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: fixture, SOS_OBSIDIAN_ROOT: '/tmp', NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.preflight.ok, false);
    assert.equal(payload.preflight.audit.ok, false);
    assert.equal(payload.preflight.audit.failures.some(item => item.code === 'operator-preferences'), true);
    assert.equal(payload.error, null);
});

test('sos status --json reports Tier 2 assets and Tier 3 archives separately from Tier 1 notes', () => {
    const fixture = checkFixture();
    mkdirSync(join(fixture, 'journal', 'assets'), { recursive: true });
    mkdirSync(join(fixture, 'journal', 'inbox', 'archive'), { recursive: true });
    writeFileSync(join(fixture, 'journal', 'assets', 'transcript-memo.md'), [
        '---',
        'id: "jrnl:transcript-memo"',
        'parent: "jrnl:charter"',
        'related: []',
        'title: "Transcript: Memo"',
        'type: "transcript"',
        'domain: "journal"',
        'exposure: "private"',
        'status: "active"',
        'created: 2026-08-18',
        'updated: 2026-08-18',
        'tags: ["test"]',
        '---',
        '',
        '# Transcript: Memo',
        ''
    ].join('\n'), 'utf-8');
    writeFileSync(join(fixture, 'journal', 'inbox', 'archive', 'memo.wav'), 'audio');
    writeFileSync(join(fixture, 'journal', 'inbox', 'archive', 'transcript-memo.json'), '{}');

    const result = spawnSync(process.execPath, [join(root, '.sos', 'sos.mjs'), 'status', '--json'], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: fixture, SOS_OBSIDIAN_ROOT: '/tmp', NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.graph.tierOneNodes, 1);
    assert.equal(payload.graph.canonicalIds, 1);
    assert.equal(payload.graph.assets, 1);
    assert.equal(payload.graph.archives, 2);
    assert.equal(payload.version, '1.5.1');
});

test('status dashboard centers each status line under the mark', () => {
    const fixture = checkFixture();
    mkdirSync(join(fixture, 'journal', 'assets'), { recursive: true });
    mkdirSync(join(fixture, 'journal', 'inbox', 'archive'), { recursive: true });
    writeFileSync(join(fixture, 'journal', 'assets', 'note.md'), '# Note\n', 'utf-8');
    writeFileSync(join(fixture, 'journal', 'inbox', 'archive', 'source.bin'), 'x', 'utf-8');
    const result = spawnSync(process.execPath, [join(root, '.sos', 'sos.mjs'), 'status'], {
        cwd: root,
        env: { ...process.env, SOS_ROOT: fixture, SOS_OBSIDIAN_ROOT: '/tmp', NO_COLOR: '1' },
        encoding: 'utf-8'
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const markWidth = 54;
    const statusLines = result.stdout.split('\n').filter(line =>
        line.includes('SOVEREIGN OS')
        || line.includes('active note')
        || line.includes('asset')
        || line.includes('Git')
        || line.includes('Inbox Zero')
        || line.includes(root)
        || line.includes(fixture)
    );
    assert.ok(statusLines.length >= 5, result.stdout);
    for (const line of statusLines) {
        const text = line.trim();
        if (text.length > markWidth) continue;
        assert.equal(line.indexOf(text), Math.floor((markWidth - text.length) / 2), line);
    }
});
