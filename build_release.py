# SPDX-License-Identifier: GPL-3.0-or-later
"""Package source + an unsigned Mac launcher; never bundle pairing records."""
import plistlib
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = "0.5.3"
FILES = ["app.py", "engine.py", "route.py", "motion.py", "geocoder.py", "favorites.py", "launch.py", "requirements.txt", "README.md", "TESTING.md", "CHANGELOG.md", "LICENSE",
         "start-mac.command", "preview.command", "start-windows.bat", "build_release.py", "scripts/check.py",
         "web/index.html", "web/app.js", "web/workspace.mjs", "tests/test_workspace.mjs", "tests/test_http.py", "web/map-coordinates.mjs", "web/motion.mjs", "web/editor-map.mjs", "web/style.css", "tests/test_editor_map.mjs", "tests/browser/demo.mjs", "tests/browser/ui_preview.py", "tests/test_engine.py", "tests/test_favorites.py", "tests/test_launch.py", "tests/test_map_coordinates.mjs", "tests/test_motion.py", "tests/test_geocoder.py", "tests/test_motion_ui.mjs", "THIRD_PARTY_NOTICES.md"]


def mac_launcher_script(version):
    return f'''#!/bin/zsh
set -eu
task_resources="$(cd -- "$(dirname -- "$0")/../Resources/ios-location-desk" && pwd)"
staged_resources="${{HOME:?}}/Library/Application Support/Waypoint/app-launchers/v{version}/Waypoint.app/Contents/Resources/ios-location-desk"
if [[ ! -f "$staged_resources/.waypoint-resource-snapshot" ]]; then
  mkdir -p "$(dirname -- "$staged_resources")"
  stage="$staged_resources.stage.$$"
  rm -rf "$stage"
  ditto "$task_resources" "$stage"
  chmod -R u+rwX "$stage"
  touch "$stage/.waypoint-resource-snapshot"
  if [[ -e "$staged_resources" ]]; then
    chmod -R u+rwX "$staged_resources"
  fi
  rm -rf "$staged_resources"
  mv "$stage" "$staged_resources"
fi
exec /usr/bin/open -a Terminal "$staged_resources/start-mac.command"
'''


def main():
    build = ROOT / "release" / f"v{VERSION}"
    bundle = build / "Waypoint.app" / "Contents"
    resources = bundle / "Resources" / "ios-location-desk"
    resources.mkdir(parents=True, exist_ok=True)
    (bundle / "MacOS").mkdir(exist_ok=True)
    for name in FILES:
        destination = resources / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, destination)
    launcher = bundle / "MacOS" / "Waypoint"
    launcher.write_text(mac_launcher_script(VERSION))
    launcher.chmod(0o755)
    (resources / "start-mac.command").chmod(0o755)
    (resources / "preview.command").chmod(0o755)
    with (bundle / "Info.plist").open("wb") as file:
        plistlib.dump({"CFBundleName": "Waypoint", "CFBundleDisplayName": "Waypoint",
                      "CFBundleIdentifier": "local.waypoint.locationdesk", "CFBundleExecutable": "Waypoint",
                      "CFBundlePackageType": "APPL", "CFBundleShortVersionString": VERSION,
                      "CFBundleVersion": VERSION.removeprefix("0."), "LSMinimumSystemVersion": "12.0", "LSUIElement": True}, file)
    archive = ROOT / f"Waypoint-v{VERSION}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
        for name in FILES:
            output.write(ROOT / name, "ios-location-desk/" + name)
        # Whitelist bundle files too: an installed launcher can acquire runtime data.
        bundle_files = [resources / name for name in FILES] + [launcher, bundle / "Info.plist"]
        for path in bundle_files:
            output.write(path, "ios-location-desk/" + str(path.relative_to(build)))
    with zipfile.ZipFile(archive) as output:
        assert output.testzip() is None
        assert not any(any(private in name for private in (".venv", "pairing", "__pycache__", "user-data", ".sqlite3")) for name in output.namelist())
        for command in ("ios-location-desk/start-mac.command", "ios-location-desk/Waypoint.app/Contents/MacOS/Waypoint"):
            assert (output.getinfo(command).external_attr >> 16) & 0o111
    print(f"{archive}\n{archive.stat().st_size} bytes")


if __name__ == "__main__":
    main()
