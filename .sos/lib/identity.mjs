/**
 * Convert a domain folder name into its canonical ID namespace.
 * Domain namespaces are intentionally not abbreviated: the folder name is the
 * globally meaningful discriminator between otherwise similar domains.
 */
export function canonicalDomainNamespace(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[\s_]+/g, '-')
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'node';
}
