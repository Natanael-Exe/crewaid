#!/usr/bin/env python3
"""Builds the packaged app's OS icons from the brand master.

Run: python3 tools/generate-icons.py          (needs Pillow; macOS for .icns)

── WHY THIS EXISTS RATHER THAN A HAND-EXPORTED ICON SET ────────────────────────

The master is a 1254x1254 RGB render with NO alpha: the squircle sits on an
opaque near-black canvas. Shipped as-is it becomes a black SQUARE in the dock —
the corners are painted, not transparent — which is the single most common way
an Electron app looks unfinished on macOS.

The background cannot be keyed by colour. The canvas reads ~21 luminance and the
dark glass body of the squircle itself reads ~25-45, so a flood fill from the
corners leaks straight through the artwork (measured: it kept 3.7% of the image).
What IS reliable is the geometry — this is a rounded rectangle, and its edge was
measured off the bright glass rim, which is ~4x the canvas luminance:

    left 134, right 1115, top 115, bottom 1091, corner radius 141

So the alpha is REBUILT from that geometry rather than extracted. The mask is
drawn at 4x and downsampled, because a rounded rectangle drawn at final size has
visibly stepped corners at 16px and 32px, which is exactly where a dock and a
taskbar render it.

── WHY macOS AND WINDOWS GET DIFFERENT PADDING ────────────────────────────────

macOS reserves the outer ~10% of the icon canvas: every first-party icon sits in
an 824px box on a 1024px grid, and an icon drawn edge-to-edge looks oversized
next to them in the dock. Windows has no such grid and trims to content, so the
same padding there just makes the taskbar icon look small. One master, two
canvases, and neither is a crop of the other.
"""

import base64
import io
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    raise SystemExit('generate-icons: needs Pillow — pip install Pillow')

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / 'packages' / 'brand' / 'masters' / 'dekstop icon.png'
# NOT `build/`: .gitignore ignores that name repo-wide as build OUTPUT, so icons
# written there are never committed and every other machine packages without them.
# These are build INPUTS, and electron-builder is pointed here by
# `directories.buildResources` in electron-builder.yml.
OUT = ROOT / 'apps' / 'desktop' / 'resources'

# Measured off the glass rim in the master; see the header.
BOX = (134, 115, 1116, 1092)
RADIUS = 141
SUPERSAMPLE = 4

# macOS icon grid: artwork occupies 824 of 1024. Windows trims to content, so it
# gets a much smaller margin or the taskbar icon reads as undersized.
MAC_CANVAS, MAC_ARTWORK = 1024, 824
WIN_CANVAS, WIN_ARTWORK = 1024, 968

# `iconutil` only accepts these, and it rejects an .iconset with anything else in it.
ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# The two in-app surfaces that show the mark. The renderer imports a file (vite
# emits and fingerprints it); the orchestrator's sign-in page is a single HTML
# STRING with no asset pipeline in front of it, so its copy has to travel inside
# the markup as a data URI — adding a route to serve one PNG would be inventing
# an endpoint the contract does not have (PRD §0 rule 2).
RENDERER_MARK = ROOT / 'packages' / 'brand' / 'assets' / 'logos' / 'app-mark.png'
SIGNIN_MARK = ROOT / 'apps' / 'orchestrator' / 'src' / 'auth' / 'brand-mark.ts'
RENDERER_MARK_PX = 256
SIGNIN_MARK_PX = 128


def artwork() -> Image.Image:
    """The squircle alone, square, with the corners actually transparent."""
    master = Image.open(MASTER).convert('RGB')
    left, top, right, bottom = BOX
    crop = master.crop(BOX)
    width, height = crop.size

    # The measured rim is a pixel or two wider than it is tall; force a square so
    # the corner radius stays circular and the icon does not render subtly ovoid.
    side = max(width, height)
    square = Image.new('RGB', (side, side), (0, 0, 0))
    square.paste(crop, ((side - width) // 2, (side - height) // 2))

    big = side * SUPERSAMPLE
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, big - 1, big - 1), radius=RADIUS * SUPERSAMPLE, fill=255
    )
    mask = mask.resize((side, side), Image.LANCZOS)

    out = square.convert('RGBA')
    out.putalpha(mask)
    return out


def on_canvas(art: Image.Image, canvas: int, inner: int) -> Image.Image:
    """Centre the artwork in a transparent canvas at the platform's own scale."""
    scaled = art.resize((inner, inner), Image.LANCZOS)
    out = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
    offset = (canvas - inner) // 2
    out.paste(scaled, (offset, offset), scaled)
    return out


def main() -> None:
    if not MASTER.is_file():
        raise SystemExit(f'generate-icons: master not found at {MASTER}')
    OUT.mkdir(parents=True, exist_ok=True)

    art = artwork()
    mac = on_canvas(art, MAC_CANVAS, MAC_ARTWORK)
    win = on_canvas(art, WIN_CANVAS, WIN_ARTWORK)

    # electron-builder's Linux target and its fallbacks both read icon.png.
    mac.save(OUT / 'icon.png')

    iconset = OUT / 'icon.iconset'
    for stale in (iconset.glob('*.png') if iconset.is_dir() else []):
        stale.unlink()
    iconset.mkdir(exist_ok=True)
    for size in ICNS_SIZES:
        mac.resize((size, size), Image.LANCZOS).save(iconset / f'icon_{size}x{size}.png')
        # @2x is the SAME pixel count as the next size up; a Retina dock reads the
        # @2x entry, so omitting these is why an icon can look soft on one display
        # and sharp on another.
        if size <= 512:
            mac.resize((size * 2, size * 2), Image.LANCZOS).save(
                iconset / f'icon_{size}x{size}@2x.png'
            )

    if sys.platform == 'darwin':
        subprocess.run(
            ['iconutil', '-c', 'icns', str(iconset), '-o', str(OUT / 'icon.icns')],
            check=True,
        )
        print(f'  icon.icns   {(OUT / "icon.icns").stat().st_size // 1024} KB')
    else:
        print('  icon.icns   SKIPPED — iconutil is macOS-only; build the mac target on a Mac')

    win.save(OUT / 'icon.ico', sizes=[(s, s) for s in ICO_SIZES])

    RENDERER_MARK.parent.mkdir(parents=True, exist_ok=True)
    art.resize((RENDERER_MARK_PX, RENDERER_MARK_PX), Image.LANCZOS).save(RENDERER_MARK)

    buf = io.BytesIO()
    art.resize((SIGNIN_MARK_PX, SIGNIN_MARK_PX), Image.LANCZOS).save(buf, format='PNG', optimize=True)
    uri = 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
    SIGNIN_MARK.write_text(
        '// GENERATED by tools/generate-icons.py from packages/brand/masters — do not edit.\n'
        '//\n'
        '// The sign-in page is one HTML string with nothing serving assets beside it, so\n'
        '// the mark rides inside the markup rather than over a second request. It is the\n'
        f'// same squircle as the app icon, at {SIGNIN_MARK_PX}px for a 2x display.\n'
        '\n'
        f"export const BRAND_MARK_DATA_URI =\n  '{uri}';\n"
    )

    print(f'  mark.png    {RENDERER_MARK_PX}x{RENDERER_MARK_PX}  {RENDERER_MARK.stat().st_size // 1024} KB')
    print(f'  brand-mark.ts  {SIGNIN_MARK_PX}px data URI, {len(uri) // 1024} KB base64')
    print(f'  icon.png    {MAC_CANVAS}x{MAC_CANVAS}')
    print(f'  icon.ico    {len(ICO_SIZES)} sizes, {(OUT / "icon.ico").stat().st_size // 1024} KB')
    print(f'written to {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
