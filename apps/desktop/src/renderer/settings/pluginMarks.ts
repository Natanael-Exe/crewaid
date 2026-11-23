/**
 * The brand mark for a curated plugin.
 *
 * The folder is the registry
 *
 * This was a generated map of explicit imports, which had one virtue — a
 * missing file was a build error — and one flaw that mattered more: adding an
 * icon did nothing until somebody regenerated the map, and nothing said so.
 * The operator dropped in a dozen marks and the pane kept drawing initials.
 *
 * `import.meta.glob` resolves at BUILD time, not runtime, so the bundle still
 * fingerprints every file and there is still no network request. What changes
 * is that the folder is the source of truth: drop `acme.svg` in `packages/brand/assets/plugins` and
 * the Acme card shows it on the next build. Nothing to regenerate, nothing to
 * keep in step.
 *
 * The file name is the slug
 *
 * `notion.svg` is the mark for the plugin whose slug is `notion`. That is the
 * whole convention, and it is deliberate: the slug is already on the wire,
 * already unique per user and already the key that namespaces a plugin's tools,
 * so nothing has to be added to `McpDirectoryEntry` to carry a
 * filename the orchestrator would then own. A file whose name matches no
 * plugin is simply never drawn.
 *
 * Drawn, not masked
 *
 * The first version masked these into a flat white silhouette on the brand's
 * colour, which works for a monochrome glyph and destroys a full-colour logo:
 * Canva became a white circle, PostHog a white scribble. Real brand marks are
 * what an operator recognises, so they are drawn as images on a light tile —
 * which is also what every plugin directory this screen was modelled on does.
 *
 * Still an `<img>` rather than inlined SVG: these are third-party files, and
 * an inlined SVG executes script where an `<img>` cannot. They are checked for
 * `script`, event handlers and external references before being committed, and
 * `img-src 'self'` covers them because they ship inside the bundle.
 */

const MARK_MODULES = import.meta.glob('../../../../../packages/brand/assets/plugins/*.svg', {
  eager: true,
  query: '?url',
  import: 'default',
});

/** `packages/brand/assets/plugins/notion.svg` → `notion`. */
function slugOfPath(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.svg$/i, '');
}

const PLUGIN_MARKS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MARK_MODULES).map(([path, url]) => [slugOfPath(path), url]),
);

/** The bundled mark for a slug, or `undefined` when the folder has none. */
export function markFor(slug: string): string | undefined {
  return PLUGIN_MARKS[slug];
}

/** Every slug the folder covers. Exported so a test can hold it to the files. */
export function markedSlugs(): readonly string[] {
  return Object.keys(PLUGIN_MARKS);
}
