# Pocket Crew

Eight distinct clay mascots with white faces and SVG avatars. Stored shape identifiers/order, name hashing, user colors and uploaded avatars retain their existing contracts.

## Assets

| Stored ID | Mascot | Color | Body |
| --- | --- | --- | --- |
| circle | Scout | #2FA59A | Low pebble |
| square | Forge | #E5533D | Rounded block |
| polygon | Beacon | #F2B233 | Offset wedge |
| egg | Ava | #3563E9 | Tall arch |
| bulb | Quill | #7B5CE0 | Leaning bean |
| cloud | Warden | #EC5FA4 | Double shoulder |
| shield | Ledger | #5E9E4B | Tapered mound |
| splat | Echo | #F27B2A | Sweeping crescent |

Individual transparent PNG masters and their generation prompts live in `packages/brand/masters/mascots/clay`. The landing page uses WebP derivatives. White faces use `#FFFFFF`; ink features use `#1B1B1B`.

The SVG bodies, white faces and features were traced from these PNGs into the app's 100 × 100 avatar space. They smooth the clay's handmade irregularities so the shapes read at small sizes.

`packages/brand/src/mascot-geometry.ts` holds the body, face and facial features; `mascot-parts.ts` holds the limbs. Both production SVG renderers consume the shared exports from `@crewaid/brand/mascot`. Standalone vectors are in `packages/brand/masters/mascots`. The existing work-ring clearance and 24/32/64-pixel previews remain covered.

## Where each form appears

- **Landing site:** the clay renders. `tools/generate-clay-assets.mjs` turns each PNG master into `packages/brand/assets/mascots/static/<id>.webp`, which `apps/web/src/content/crew.ts` maps to its crew member. In-page UI that imitates the app, such as chat rows and routine logs, uses the same SVG avatar as the app.
- **Desktop app:** the SVGs, drawn by `BotAvatar` from `@crewaid/brand/mascot` in the bot's own color.

## Regeneration

```sh
pnpm --filter @crewaid/brand build
node tools/generate-mascot-svgs.mjs
node tools/generate-clay-assets.mjs
```

The WebP generator verifies transparent alpha; PNGs remain the generated masters. The SVG geometry is edited directly in `mascot-geometry.ts` and `mascot-parts.ts`; the standalone SVGs are regenerated from it.

## Validation

The original implementation passed `pnpm pre-review`, including 1,092 desktop tests, 35 web tests and all 29 Electron end-to-end tests. A 3D exploration (a Spline scene, Meshy models and a React Three Fiber lab) was tried on this branch and removed; it remains in the branch history.
