import { fail } from './cli.mjs';
import { enrichInboxItems, scanInboxes } from './inbox-scan.mjs';
import { ui } from './terminal.mjs';

export function inboxCommand(args, options, ctx) {
    const { repoRoot, discoverDomains } = ctx;
    if (options.dryRun) return fail('--dry-run is not applicable to the read-only inbox command.', options);
    let domain = null;
    let type = null;
    let selector = null;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--domain') {
            domain = args[++index];
            if (!domain) return fail('--domain requires a domain name.', options);
        } else if (arg === '--captures') {
            if (type) return fail('Only one inbox type filter may be used.', options);
            type = 'capture';
        } else if (arg === '--batches') {
            if (type) return fail('Only one inbox type filter may be used.', options);
            type = 'batch';
        } else if (arg === '--debriefs' || arg === '--handoffs') {
            if (type) return fail('Only one inbox type filter may be used.', options);
            type = 'debrief';
        } else if (arg.startsWith('-')) {
            return fail(`Unknown inbox option: ${arg}`, options);
        } else if (selector) {
            return fail(`Expected one inbox selector, received: ${selector}, ${arg}`, options);
        } else {
            selector = arg;
        }
    }

    const knownDomains = new Set(discoverDomains().map(item => item.name));
    if (domain && !knownDomains.has(domain)) return fail(`Unknown domain: ${domain}`, options);

    let items = scanInboxes(discoverDomains, { repoRoot });
    if (domain) items = items.filter(item => item.domain === domain);
    if (type) items = items.filter(item => item.type === type);
    if (selector) {
        const needle = selector.toLowerCase();
        items = items.filter(item => item.name.toLowerCase().includes(needle) || item.displayPath.toLowerCase().includes(needle));
    }
    items = enrichInboxItems(items, options.verbose);

    const result = {
        ok: true,
        filters: { selector, domain, type },
        count: items.length,
        items: items.map(({ path: _path, ...item }) => item)
    };
    if (options.json) return console.log(JSON.stringify(result, null, 2));
    if (options.quiet) return;

    if (items.length === 0) {
        console.log(ui.success('Inbox Zero — no matching pending items.'));
        return;
    }
    console.log(ui.heading(`${items.length} pending inbox item(s):`));
    for (const item of items) {
        const marker = item.type === 'debrief' ? 'D' : item.type === 'batch' ? 'B' : 'C';
        const color = item.type === 'debrief' ? ui.warning : item.type === 'batch' ? ui.command : ui.success;
        const count = item.type === 'batch' && item.files?.length ? ui.muted(` (${item.files.length})`) : '';
        console.log(`  ${color(marker)}  ${item.displayPath}${count} ${ui.muted(`[${item.location}]`)}`);
        if (options.verbose && item.type === 'batch' && item.files?.length) {
            for (const file of item.files) {
                console.log(`       ${ui.muted(file.relativePath)} ${ui.muted(`[${file.type}]`)}`);
            }
        }
    }
}
