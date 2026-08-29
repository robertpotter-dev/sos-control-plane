const ANSI = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    brightCyan: '\x1b[96m',
    cyan: '\x1b[36m'
};

function supportsColor() {
    if (process.env.NO_COLOR !== undefined) return false;
    if (process.env.SOS_COLOR === 'always' || process.env.FORCE_COLOR === '1') return true;
    return Boolean(process.stdout.isTTY);
}

function paint(code, value) {
    const text = String(value);
    return supportsColor() ? `${code}${text}${ANSI.reset}` : text;
}

export const ui = {
    accent: value => paint(`${ANSI.bold}${ANSI.cyan}`, value),
    command: value => paint(ANSI.brightCyan, value),
    option: value => paint(ANSI.blue, value),
    heading: value => paint(ANSI.bold, value),
    success: value => paint(ANSI.green, value),
    warning: value => paint(ANSI.yellow, value),
    error: value => paint(ANSI.red, value),
    muted: value => paint(ANSI.dim, value)
};

export function colorizeHelp(text) {
    const sectionHeadings = new Set(['Sovereign OS', 'Commands', 'Details', 'Selection', 'Options', 'Filters — choose one', 'Requirements', 'Typical flow:']);
    return text.split('\n').map(line => {
        if (sectionHeadings.has(line.trim())) return ui.heading(line);
        let styled = line.replace(/(^\s*(?:\d+\.\s+)?)(sos(?:\s+(?:init|inbox|ingest|fetch|graph|trace|audit|check|sync|upgrade|doctor|help|status|config))?|debrief|review charter <domain>|brief me on <topic>|weave <node-id>)(?=\s|$)/, (_match, indent, command) => `${indent}${ui.command(command)}`);
        styled = styled.replace(/(--[a-z][a-z-]*(?:\s+<[^>]+>)?)/g, match => ui.option(match));
        if (/^\s{2,}"This shows/.test(line)) styled = ui.muted(styled);
        return styled;
    }).join('\n');
}
