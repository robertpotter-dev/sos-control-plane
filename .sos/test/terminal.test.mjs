import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const terminalUrl = pathToFileURL(join(root, '.sos', 'lib', 'terminal.mjs')).href;
const renderScript = `import { ui } from ${JSON.stringify(terminalUrl)}; console.log(ui.command('CMD'), ui.option('--deep'), ui.success('PASS'), ui.warning('WARN'), ui.error('FAIL'), ui.muted('path'));`;

function render(env) {
    return spawnSync(process.execPath, ['--input-type=module', '--eval', renderScript], {
        encoding: 'utf-8',
        env: { ...process.env, ...env }
    });
}

test('semantic terminal colors can be forced for previews and tests', () => {
    const result = render({ SOS_COLOR: 'always', NO_COLOR: undefined });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /\u001b\[96mCMD/);
    assert.match(result.stdout, /\u001b\[34m--deep/);
    assert.match(result.stdout, /\u001b\[32mPASS/);
    assert.match(result.stdout, /\u001b\[33mWARN/);
    assert.match(result.stdout, /\u001b\[31mFAIL/);
});

test('help colors sos fetch like the other commands', async () => {
    const { colorizeHelp } = await import(terminalUrl);
    const previous = process.env.SOS_COLOR;
    process.env.SOS_COLOR = 'always';
    delete process.env.NO_COLOR;
    try {
        const fetchLine = colorizeHelp('  sos fetch           Download remote video/audio into a domain inbox for ingest.');
        const ingestLine = colorizeHelp('  sos ingest          Run the local sensor pipeline and create deterministic debrief records.');
        const upgradeLine = colorizeHelp('  sos upgrade         Overlay the control plane onto this instance.');
        const traceLine = colorizeHelp('  sos trace           Follow evidence linked from one exact Tier 1 node.');
        assert.match(fetchLine, /\u001b\[96msos fetch\u001b\[0m/);
        assert.match(ingestLine, /\u001b\[96msos ingest\u001b\[0m/);
        assert.match(upgradeLine, /\u001b\[96msos upgrade\u001b\[0m/);
        assert.match(traceLine, /\u001b\[96msos trace\u001b\[0m/);
        const page = colorizeHelp('Requirements\n  yt-dlp              Required.');
        assert.match(page, /\u001b\[1mRequirements\u001b\[0m/);
    } finally {
        if (previous === undefined) delete process.env.SOS_COLOR;
        else process.env.SOS_COLOR = previous;
    }
});

test('NO_COLOR suppresses every ANSI sequence', () => {
    const result = render({ SOS_COLOR: 'always', NO_COLOR: '1' });

    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /\u001b\[/);
    assert.match(result.stdout, /CMD --deep PASS WARN FAIL path/);
});
