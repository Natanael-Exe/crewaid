# @crewaid/brand

Shared identity artwork for Crewaid. Consumers import files from this package rather than keeping their own copies.

## Asset ownership

| Location | Contents |
|---|---|
| `assets/logos/` | Lockups, app-icon preview, and the desktop sign-in mark. |
| `assets/mascots/static/` | Complete clay characters as optimized WebP files. |
| `assets/mascots/` | Body, face, eyes, and nose layers used by animated `ClayMascot` avatars. |
| `assets/portraits/` | Approved transparent portrait exports. |
| `assets/plugins/` | Third-party app marks used by the plugin directory. Each filename is its plugin slug. |

Desktop room backgrounds, fonts, and platform-specific `.icns`, `.ico`, and `.png` delivery outputs live in `apps/desktop`.

## Imports

Vite processes direct asset imports with its image pipeline:

```ts
import notion from '@crewaid/brand/assets/plugins/notion.svg';
import mascot from '@crewaid/brand/assets/mascots/static/circle.webp';
```

The desktop's `settings/pluginMarks.ts` discovers the shared plugin folder at build time with `import.meta.glob`, so adding a `<slug>.svg` makes it available on the next build without maintaining a second registry.

## Components and geometry

`@crewaid/brand/mascot` exports the eight silhouette definitions and the name hash that picks a bot's default shape. Persisted shape identifiers retain their order. `@crewaid/brand/clay` renders animated clay avatars, and `@crewaid/brand/mascot.css` provides their animation styles. User colors and uploaded avatars still apply.

The silhouette references are described in [`docs/design/pocket-crew`](../../docs/design/pocket-crew/README.md).
