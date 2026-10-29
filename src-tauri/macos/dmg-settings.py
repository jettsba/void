# Layout of the macOS installer window, consumed by dmgbuild:
#   dmgbuild -s src-tauri/macos/dmg-settings.py -D app=<path to Void.app> Void <out.dmg>
#
# Why not Tauri's own dmg target: it styles the window by scripting Finder
# (AppleScript), and Finder silently dropped the background and icon positions
# (checked on macOS 27: the script reports success, .DS_Store has neither).
# dmgbuild writes .DS_Store directly, no Finder involved.
#
# dmg-background.png + dmg-background@2x.png are merged into one hi-dpi TIFF,
# so the window is sharp on retina. The window shows 760x400 pt (+ Finder's
# title bar: 28 pt on macOS 13-15, 32 pt on 26+); the picture is 2560x1600 —
# Finder paints anything outside the picture white, so a window dragged
# bigger has to keep landing on the starfield. Icon centres here must match
# src-tauri/macos/dmg-background.py.
#
# Finder draws icon labels in black on a picture background, even in dark
# mode (the background colour in .DS_Store doesn't change that — checked).
# The picture puts a light void-style capsule under each label, so the
# system label reads as black text on a light pill. Label size and the
# capsules' geometry in dmg-background.py go together.
import os.path

app = defines["app"]  # noqa: F821 (injected by dmgbuild)
here = defines.get("assets", "src-tauri/macos")  # noqa: F821 (dir of the backgrounds)

files = [app]
symlinks = {"Applications": "/Applications"}
icon = os.path.join(app, "Contents", "Resources", "icon.icns")
format = "ULFO"

background = os.path.join(here, "dmg-background.png")
window_rect = ((200, 140), (760, 432))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
icon_size = 108
text_size = 12
icon_locations = {
    os.path.basename(app): (210, 182),
    "Applications": (550, 182),
}
hide_extensions = [os.path.basename(app)]
