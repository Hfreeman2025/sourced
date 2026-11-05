# Harry Freeman’s maker’s mark

The badge and monogram that mark Harry Freeman’s work. They are drawn from the brass nameplate on his site’s office door: an ink cell holding the monogram, then a brass plate with a darker bevelled edge, the name engraved with a light line beneath it, and two screws.

| File | Use |
| --- | --- |
| `hf-badge.svg` | README badge, 24 px tall: “Harry Freeman” |
| `hf-badge-lab.svg` | README badge for lab pieces: “Harry Freeman · Lab” |
| `hf-mark.svg` | Square monogram for favicons and avatars |
| `hf-mark-16.png`, `hf-mark-32.png`, `hf-mark-64.png` | The monogram rasterised for favicons |
| `preview-light.png`, `preview-dark.png` | Renders on GitHub’s light (`#ffffff`) and dark (`#0d1117`) README backgrounds |

## Usage

Right under a README’s title:

```markdown
[![Harry Freeman](docs/brand/hf-badge.svg)](https://harryfreeman.dev)
```

As a favicon:

```html
<link rel="icon" href="/hf-mark.svg" type="image/svg+xml">
<link rel="icon" href="/hf-mark-32.png" sizes="32x32" type="image/png">
```

## Colours

Ink `#1f2433`, brass edge `#d9a63b`, brass face `#f0c766`, engraving `#3b2a08`, highlight `#fbe6ad`. All fills are solid, so the marks read the same on light and dark backgrounds.

## Lettering

IBM Plex Sans Condensed SemiBold, converted to outlined paths: the SVGs load no font, which matters because GitHub strips web fonts from READMEs. `make-brand.mjs` regenerates every SVG from the font file; see its header for the command. See [LICENSE.md](LICENSE.md) for the font’s terms.
