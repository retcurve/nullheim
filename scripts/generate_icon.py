#!/usr/bin/env python3
"""Cuts the PWA install icons out of the boot wordmark itself.

`public/app.js`'s LOGO is 8 letters of ANSI-shadow figlet art, 13 character
cells each. This takes the first of them — the "n" — straight from a
screenshot of the running terminal (scanline overlay and phosphor glow
turned off, so only the glyph's own block characters are captured) and sits
it on a square of the terminal background.

Not part of the application, and not run by anything — it is here so the
icons can be re-cut rather than redrawn if the wordmark ever changes:

    node src/cli.ts serve --port 8765 &
    python3 scripts/generate_icon.py

which needs Playwright and Pillow. The intermediate screenshot is cached at
SOURCE; pass --shoot to retake it.
"""

import subprocess
import sys
from pathlib import Path

from PIL import Image

BG = (0x00, 0x14, 0x00)  # --bg
CELLS_PER_LETTER = 13
LETTERS = 8
ROWS = 7
MARGIN = 0.06  # of the canvas, per side

SOURCE = Path("/tmp/nullheim-logo.png")

SHOOT = """
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await b.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
  await p.goto('http://localhost:8765/enter');
  await p.waitForSelector('.entry.logo');
  // The scanlines and glow are the screen, not the letterform; the logo
  // element is normally clipped to the terminal's width, so let it size to
  // its own content or the wordmark is cut off mid-word.
  await p.addStyleTag({ content: `
    #crt::before, #crt::after { display: none !important; }
    #output .entry.logo {
      font-size: 30px !important; line-height: 1 !important;
      text-shadow: none !important; overflow: visible !important;
      width: max-content !important; position: fixed !important;
      left: 0 !important; top: 0 !important; z-index: 9999 !important;
      background: #001400 !important; padding: 0 !important; margin: 0 !important;
    }
  ` });
  await p.waitForTimeout(300);
  const box = await p.$eval('.entry.logo', e => e.getBoundingClientRect().toJSON());
  await p.setViewportSize({ width: Math.ceil(box.width) + 40, height: Math.ceil(box.height) + 40 });
  await p.waitForTimeout(200);
  await (await p.$('.entry.logo')).screenshot({ path: process.argv[1] });
  await b.close();
})();
"""


def shoot(path: Path) -> None:
    subprocess.run(
        ["node", "-e", SHOOT, str(path)],
        check=True,
        env={"NODE_PATH": "/opt/node22/lib/node_modules", "PATH": "/usr/bin:/bin:/opt/node22/bin"},
    )


def letter_n(source: Path) -> Image.Image:
    """The first 13 cells of the wordmark, cropped to its own ink."""
    logo = Image.open(source).convert("RGB")
    ink = [x for x in range(logo.width) if any(sum(logo.getpixel((x, y))) > 120 for y in range(logo.height))]
    cell = (max(ink) + 1) / (CELLS_PER_LETTER * LETTERS + 1)
    n = logo.crop((0, 0, round(cell * CELLS_PER_LETTER), logo.height))
    return n.crop(n.convert("L").point(lambda v: 255 if v > 40 else 0).getbbox())


def flatten(glyph: Image.Image, rows: int) -> Image.Image:
    """One flat tone per character cell.

    ░▒▓ are drawn as dot patterns, and at 192px those dots survive resampling
    and swamp the letterform — the icon reads as a noisy square rather than an
    n. Box-averaging each cell to a single colour is what the eye does with
    the wordmark anyway: the shading stays, the dots go.
    """
    return glyph.resize((CELLS_PER_LETTER, rows), Image.BOX)


def icon(cells: Image.Image, size: int) -> Image.Image:
    box = round(size * (1 - 2 * MARGIN))
    scale = min(box / cells.width, box / cells.height)
    # NEAREST, so cell edges stay hard at every size rather than smearing.
    fitted = cells.resize((round(cells.width * scale), round(cells.height * scale)), Image.NEAREST)
    im = Image.new("RGB", (size, size), BG)
    im.paste(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))
    return im


if "--shoot" in sys.argv or not SOURCE.exists():
    shoot(SOURCE)

glyph = letter_n(SOURCE)
cells = flatten(glyph, rows=ROWS)
for size, path in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png")]:
    icon(cells, size).save(Path("public") / path)
    print(f"wrote public/{path} ({size}x{size}) from a {glyph.width}x{glyph.height} crop")
