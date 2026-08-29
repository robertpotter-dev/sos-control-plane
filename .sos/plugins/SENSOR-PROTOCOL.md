# Sensor Plugin Protocol

Sensor plugins with `plugin.json` are instance extensions for source formats that the built-in ingestion engines do not recognize. They are not the kernel OS adapters (`apple-metal`, `linux`, `windows`); those overlay with the control plane. Instance plugins are deliberately not user-facing commands: `sos ingest` discovers them by file extension, asks each candidate to probe the source, and runs the highest-confidence match. `sos upgrade` leaves any `.sos/plugins/<name>/` tree that has `plugin.json` in place.

## Plugin manifest

Each `.sos/plugins/<name>/plugin.json` may declare a `sensors` object. A sensor requires:

- `script`: executable Node.js module implementing `probe` and `extract` actions.
- `description`: one sentence describing the source structure.
- `extensions`: candidate dotted extensions; these narrow discovery but never replace probing.

Optional fields are `tags` and numeric `priority`. Required aggregate-record tags are supplied by the kernel: the domain name, `assets`, `t2-record`, `sensor-output`, and `scope-single` or `scope-batch`. Sensor tags describe the payload without claiming interpretation, for example `structured-history`, `event-index`, or `export-dump`.

## Executable contract

Probe:

```text
node sensor.mjs probe --source <path> --json
```

Return `{ "match": true|false, "confidence": 0..100, "format": "..." }`.

Extract:

```text
node sensor.mjs extract --source <path> --output-dir <domain/assets> --stem <slug> --domain <name> --exposure <class> --source-sha256 <hash> --json [--dry-run]
```

Stdout is a compact JSON envelope. Observation indexes and other payloads are files under `--output-dir`. Printing the corpus on stdout is a protocol violation.

Return an object with `ok`, one or more `outputs`, `recordCount`, `warnings`, optional `tags`, optional `summaryMarkdown`, and optional `recordProfile`. Prefer output objects shaped as `{ "path": "...", "role": "event-index", "mediaType": "application/x-ndjson" }`; a bare path remains valid for payloads that need no extra description. A plugin may mark exactly one Markdown output with `"primary": true` when that file already contains its own custody metadata, source link, and readable extraction. Otherwise the kernel writes the primary Tier 2 record and uses `recordProfile` fields (`prefix`, `titlePrefix`, `type`, and `description`) to name it. Output paths must remain inside the supplied assets directory. The kernel, not the plugin, archives the source, supplies the required record tags, and creates the debrief record.

The common primary-record contract is intentionally small. Required tags are `assets`, `t2-record`, `sensor-output`, the domain name, one `scope-*` tag, and one `sensor-*` tag per sensor. Plugins add factual routing tags such as source, format, and payload role; they must not add inferred personal categories.

## Human projection versus machine index

Every completed intake unit gets one primary Markdown Tier 2 record. It is the cleaned, human-readable, vault-approved projection: it identifies custody, links the Tier 3 source, lists companion Tier 2 payloads, reports extraction details, and carries warnings. For a singleton capture, an existing Markdown transcript, text capture, PDF capture, spreadsheet capture, visual ledger, or plugin-declared record fills this role directly. The kernel creates a separate aggregate record only when no Markdown projection exists or when a folder batch needs one entrypoint.

Machine-generated observation indexes use JSON Lines, including indexes containing only one still-image observation. Each line must be independently valid JSON and carry a stable `record_id`, source identity, and the narrowest faithful locator. Speech uses `.segments.jsonl`; structured histories use `.events.jsonl`; still-image telemetry uses `.vision.jsonl`. Plain `.json` is reserved for genuinely singular configuration, schema, or tree documents—not sensor observation indexes. Video ingest produces a readable transcript plus timestamped speech segments and preserves the untouched video as Tier 3 visual ground truth; it does not manufacture representative stills. Text, PDFs, and spreadsheets may need only their readable Markdown capture when they do not produce a repeated observation index. Every generated file is Tier 2 and belongs in `assets/`; sensors must never generate output in `inbox/archive/`.

## Structured event indexes

When the faithful extraction is a set or stream of machine observations, JSON Lines is required so any record can be searched, cited, or streamed without loading the whole corpus. Each record must include:

- A stable `record_id`.
- `occurred_at` when the source timestamp can be normalized, plus the verbatim `occurred_at_raw` when available.
- Mechanically observed source fields rather than a universal event ontology.
- `source_file` and, where useful for independent identity, `source_sha256`; also include the narrowest available locator, such as `source_line_start` / `source_line_end`, page, row, byte range, media timecode, or a source-native record key.

Fields such as `title`, `publisher`, `content_url`, and `activity` are source-specific additions, not universal requirements. Preserve uncertainty as nulls or warnings; do not fabricate values to satisfy a schema.

## Extraction discipline

- Preserve mechanically observable fields; do not infer personal meaning.
- Provide stable record identifiers and source locators when the format permits them.
- Report rejected or ambiguous records rather than silently dropping them.
- Stream large inputs and outputs when practical; never require a frontier model to hold an entire raw history in context.
- Do not write Tier 1, archive the source, or create a debrief record.
- Keep execution local by default. Network enrichment is a separate, explicit operation.
