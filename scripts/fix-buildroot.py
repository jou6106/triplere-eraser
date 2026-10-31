#!/usr/bin/env python3
"""Remove the obsolete hiredis patch from the pinned ShredOS source tree."""

import hashlib
from pathlib import Path
import sys


def fix_hiredis(root):
    package = Path(root) / "package" / "hiredis"
    patch = package / "0001-CMakeList-add-option-to-not-install-NuGet-packaging.patch"
    if not patch.exists():
        return
    recipe = (package / "hiredis.mk").read_text()
    if "HIREDIS_VERSION_MAJOR = 1.3\n" not in recipe or "HIREDIS_VERSION = $(HIREDIS_VERSION_MAJOR).0\n" not in recipe:
        raise RuntimeError("hiredis version changed; review the source fix before building")
    expected = "6c0ae568e8c83c7fa0b3c339df102581e0ceb379db4829267f24fbf46861f0a7"
    if hashlib.sha256(patch.read_bytes()).hexdigest() != expected:
        raise RuntimeError("hiredis patch changed; refusing to remove an unrecognized patch")
    # ENABLE_NUGET is already present in upstream hiredis v1.3.0.
    patch.unlink()
    print("Removed hiredis NuGet patch already included in v1.3.0")


if __name__ == "__main__":
    try:
        fix_hiredis(sys.argv[1])
    except (IndexError, OSError, RuntimeError) as error:
        sys.exit(f"fix-buildroot: {error}")
