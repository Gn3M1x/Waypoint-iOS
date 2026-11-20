# SPDX-License-Identifier: GPL-3.0-or-later
import tempfile
import unittest
from pathlib import Path

from favorites import default_demo_data_directory
from launch import runtime_environment
from build_release import mac_launcher_script


class LaunchPathTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)

    def test_source_checkout_keeps_its_private_environment_local(self):
        root = self.base/"source"
        root.mkdir()
        self.assertEqual(runtime_environment(root), root.resolve()/".venv")

    def test_bundled_environment_is_writable_and_tracks_requirements(self):
        bundle = self.base/"Waypoint.app"
        root = bundle/"Contents"/"Resources"/"ios-location-desk"
        root.mkdir(parents=True)
        requirements = root/"requirements.txt"
        requirements.write_text("pymobiledevice3==11.61.0\ncertifi\n")
        support = self.base/"Application Support"/"Waypoint"

        first = runtime_environment(root, support)
        self.assertTrue(first.is_relative_to(support))
        self.assertFalse(first.is_relative_to(bundle))
        self.assertIn("runtimes", first.parts)

        requirements.write_text("pymobiledevice3==11.62.0\ncertifi\n")
        second = runtime_environment(root, support)
        self.assertNotEqual(first, second)

    def test_bundled_demo_data_uses_application_support(self):
        root = self.base/"Waypoint.app"/"Contents"/"Resources"/"ios-location-desk"
        support = self.base/"Application Support"/"Waypoint"
        self.assertEqual(default_demo_data_directory(root, support), support/"demo")
        self.assertNotIn("Waypoint.app", str(default_demo_data_directory(root, support)))

    def test_app_launcher_stages_resources_before_opening_terminal(self):
        script = mac_launcher_script("0.5.3")
        self.assertIn("app-launchers/v0.5.3/Waypoint.app/Contents/Resources/ios-location-desk", script)
        self.assertLess(script.index('ditto "$task_resources" "$stage"'), script.index("/usr/bin/open"))
        self.assertIn(".waypoint-resource-snapshot", script)


if __name__ == "__main__":
    unittest.main()
