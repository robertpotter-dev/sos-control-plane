import { ui } from './terminal.mjs';

export function fail(message, options = {}, exitCode = 1) {
    if (options.json) {
        console.log(JSON.stringify({ ok: false, error: message, exitCode }, null, 2));
    } else {
        console.error(ui.error(`Error: ${message}`));
    }
    process.exitCode = exitCode;
}
