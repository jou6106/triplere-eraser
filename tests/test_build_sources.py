import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


PROJECT = Path(__file__).resolve().parents[1]
SOURCE = Path(os.environ.get("SHREDOS_SOURCE", PROJECT.parent / "shredos"))
PATCH_NAME = "0001-CMakeList-add-option-to-not-install-NuGet-packaging.patch"
spec = importlib.util.spec_from_file_location("fix_buildroot", PROJECT / "scripts/fix-buildroot.py")
fix_buildroot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fix_buildroot)


class HiredisFixTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Read the pristine patch, even after apply.sh has removed the worktree copy.
        cls.original_patch = subprocess.check_output([
            "git", "-C", str(SOURCE), "show", f"HEAD:package/hiredis/{PATCH_NAME}"
        ])

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package = self.root / "package/hiredis"
        self.package.mkdir(parents=True)
        self.recipe = self.package / "hiredis.mk"
        self.recipe.write_text("HIREDIS_VERSION_MAJOR = 1.3\nHIREDIS_VERSION = $(HIREDIS_VERSION_MAJOR).0\n")
        self.patch = self.package / PATCH_NAME
        self.patch.write_bytes(self.original_patch)

    def test_removes_only_obsolete_patch_and_can_repeat(self):
        unrelated = self.package / "another.patch"
        unrelated.write_text("keep")
        fix_buildroot.fix_hiredis(self.root)
        fix_buildroot.fix_hiredis(self.root)
        self.assertFalse(self.patch.exists())
        self.assertEqual(unrelated.read_text(), "keep")

    def test_refuses_changed_patch(self):
        self.patch.write_bytes(self.original_patch + b"changed\n")
        with self.assertRaisesRegex(RuntimeError, "patch changed"):
            fix_buildroot.fix_hiredis(self.root)
        self.assertTrue(self.patch.exists())

    def test_refuses_different_version(self):
        self.recipe.write_text("HIREDIS_VERSION_MAJOR = 1.4\n")
        with self.assertRaisesRegex(RuntimeError, "version changed"):
            fix_buildroot.fix_hiredis(self.root)
        self.assertTrue(self.patch.exists())


class SourceDownloadTests(unittest.TestCase):
    def run_download(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make = root / "make"
            make.write_text("""#!/bin/bash
count=0
[ ! -f calls ] || read -r count < calls
count=$((count + 1))
echo "$count" > calls
case "$TEST_MODE" in
  success) echo 'downloaded'; exit 0 ;;
  patch) echo 'make: .stamp_downloaded Error 1'; echo '2 out of 2 hunks FAILED'; echo 'make: .stamp_patched Error 1'; exit 2 ;;
  unknown) echo 'compiler failed'; exit 2 ;;
  transient) [ "$count" -ne 2 ] || { echo 'downloaded'; exit 0; } ;;
esac
echo 'make: /build/example/.stamp_downloaded] Error 1'
exit 2
""")
            make.chmod(0o755)
            result = subprocess.run(
                ["bash", str(PROJECT / "scripts/download-sources.sh")],
                cwd=root,
                env={**os.environ, "PATH": f"{root}:{os.environ['PATH']}",
                     "TEST_MODE": mode, "DOWNLOAD_RETRY_DELAY": "0"},
                capture_output=True, text=True, timeout=10
            )
            return result, int((root / "calls").read_text()), sorted(
                path.name for path in root.glob("download-attempt-*.log")
            )

    def test_success_runs_once_and_saves_log(self):
        result, calls, logs = self.run_download("success")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, 1)
        self.assertEqual(logs, ["download-attempt-1.log"])

    def test_transient_download_retries_and_recovers(self):
        result, calls, logs = self.run_download("transient")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, 2)
        self.assertEqual(len(logs), 2)

    def test_download_failure_stops_after_three_attempts(self):
        result, calls, logs = self.run_download("persistent")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(calls, 3)
        self.assertEqual(len(logs), 3)

    def test_patch_failure_is_not_retried(self):
        result, calls, _ = self.run_download("patch")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, 1)

    def test_unknown_failure_is_not_retried(self):
        result, calls, _ = self.run_download("unknown")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, 1)
