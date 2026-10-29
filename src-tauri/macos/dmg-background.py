# Source of src-tauri/macos/dmg-background(@2x).png — the macOS installer
# window. Writes an HTML page; scripts/render-dmg-background.mjs screenshots
# it at 2x with the project's own JetBrains Mono:
#
#   python3 src-tauri/macos/dmg-background.py > /tmp/dmg-bg.html
#   node scripts/render-dmg-background.mjs /tmp/dmg-bg.html
#
# Geometry must match src-tauri/macos/dmg-settings.py (window, icon centres, size).
import os, random

F = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "public", "static", "fonts"))

# The window shows W x H; the picture is much larger. Finder anchors it at the
# top-left and paints everything outside it white, so a window someone drags
# bigger must still land on starfield, not on a white void.
W, H = 760, 400
IMG_W, IMG_H = 2560, 1600

ICON = 108                              # icon_size in dmg-settings.py
APP_X, APPS_X, MID_X = 210, 550, 380    # icon centres; chevrons between them
ICON_Y = 182                            # icons + labels centred in the window
ICON_BOTTOM = ICON_Y + ICON // 2

# Finder draws its own label under each icon, in BLACK on a picture background
# (even in dark mode), and nothing in .DS_Store changes that. So instead of
# fighting it, the picture puts a light void-style capsule (--fg, soft glow)
# exactly under each label: black text on a light pill reads as a primary
# button. Measured at text_size 12: label centre at ICON_BOTTOM + 16.5,
# "Void.app" 49 pt wide, "Applications" 69 pt.
PILL_Y = ICON_BOTTOM + 16.5
PILL_H = 22
PILLS = ((APP_X, 76), (APPS_X, 96))     # (centre x, width)

random.seed(7)
stars = []
for _ in range(800):
    x, y = random.uniform(8, IMG_W - 8), random.uniform(8, IMG_H - 8)
    if 100 < y < 310 and 120 < x < 640: continue   # icons, chevrons, labels
    r = random.choice([0.5, 0.6, 0.75, 0.9])
    o = random.uniform(0.18, 0.55)
    stars.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="#e6e6e8" opacity="{o:.2f}"/>')

# Three chevrons stepping up in brightness, sized against the 108 pt icons:
# ~22 pt tall, the same stroke weight as the app icon ring.
arrow = ''.join(f'<path d="M{cx-5.5} {ICON_Y-11} L{cx+5.5} {ICON_Y} L{cx-5.5} {ICON_Y+11}" fill="none" stroke="#e6e6e8" stroke-opacity="{o}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>'
                for cx, o in ((MID_X - 26, .2), (MID_X, .45), (MID_X + 26, .85)))

# Glow first (blurred copy, faint), then the crisp capsule on top.
pills = ''.join(
    f'<rect x="{cx - w / 2}" y="{PILL_Y - PILL_H / 2}" width="{w}" height="{PILL_H}" rx="{PILL_H / 2}" fill="#e6e6e8" opacity=".28" filter="url(#glow)"/>'
    f'<rect x="{cx - w / 2}" y="{PILL_Y - PILL_H / 2}" width="{w}" height="{PILL_H}" rx="{PILL_H / 2}" fill="#e6e6e8"/>'
    for cx, w in PILLS)

html = f'''<!doctype html><html><head><meta charset="utf-8"><style>
@font-face {{ font-family: JBM; src: url("file://{F}/JetBrainsMono-Regular.woff2"); font-weight: 400; }}
html,body {{ margin:0; width:{IMG_W}px; height:{IMG_H}px; overflow:hidden; background:#0a0a0b; }}
.stage {{ position:relative; width:{IMG_W}px; height:{IMG_H}px;
  background:
    radial-gradient(ellipse 320px 84px at {MID_X}px {ICON_Y}px, rgba(230,230,232,0.05), transparent 70%),
    radial-gradient(ellipse 600px 330px at {MID_X}px {ICON_Y + 20}px, rgba(255,255,255,0.014), transparent 75%),
    #0a0a0b; }}
svg {{ position:absolute; inset:0; }}
</style></head><body><div class="stage">
<svg width="{IMG_W}" height="{IMG_H}" viewBox="0 0 {IMG_W} {IMG_H}"><defs><filter id="glow" x="-50%" y="-200%" width="200%" height="500%"><feGaussianBlur stdDeviation="9"/></filter></defs>
{''.join(stars)}{arrow}{pills}</svg>
</div></body></html>'''
print(html)
