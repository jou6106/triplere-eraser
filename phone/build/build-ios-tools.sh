#!/bin/bash
# Builds the iPhone/iPad tools for Windows (MSYS2 MINGW64 shell, GitHub Actions windows runner):
# libplist, libimobiledevice-glue, libusbmuxd, libtatsu, libimobiledevice, libirecovery,
# idevicerestore at pinned upstream commits, plus triplere-recovery-list. Output: $OUT with the
# .exe files, every DLL they need, the licences and the exact sources used (LGPL).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?usage: build-ios-tools.sh <out-dir>}"
WORK="${WORK:-$PWD/ios-src}"
PREFIX=/mingw64
JOBS=$(nproc)

# Pinned upstream commits (2026-11-18). Update together, then rerun the phone workflow.
REPOS=(
  "libplist b3f14c22dbb29056c0d3c37bb9b2401ffdb7bc8f --without-cython"
  "libimobiledevice-glue 420053a5fc536062014a121e14d847db914be999"
  "libusbmuxd cf4b806dff1003e56b8219367bbb29cb01c3f619"
  "libtatsu b8d518a7d188c8c98dd9e6debb855bb2809699ee"
  "libimobiledevice 60bf03b4cac8ed5f52f803cdb031a404c0da3beb --without-cython"
  "libirecovery c98bf2f7a0859b2579ef140f75ef876af10f40b0"
  "idevicerestore 5815eed70fd14d4ca98d4a498e38d776ffff88cd"
)

mkdir -p "$WORK" "$OUT/licenses"
: > "$OUT/licenses/SOURCES.txt"
for entry in "${REPOS[@]}"; do
  read -r name commit flags <<<"$entry"
  echo "::group::$name @ $commit"
  rm -rf "$WORK/$name"
  git clone --quiet "https://github.com/libimobiledevice/$name.git" "$WORK/$name"
  git -C "$WORK/$name" checkout --quiet "$commit"
  (
    cd "$WORK/$name"
    ./autogen.sh --prefix="$PREFIX" --disable-static --enable-shared ${flags:-} \
      PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"
    make -j"$JOBS"
    make install
  )
  for f in COPYING COPYING.LESSER COPYING.LGPLv2.1 LICENSE; do
    [ -f "$WORK/$name/$f" ] && cp "$WORK/$name/$f" "$OUT/licenses/$name-$f"
  done
  echo "$name https://github.com/libimobiledevice/$name/tree/$commit" >> "$OUT/licenses/SOURCES.txt"
  echo "::endgroup::"
done

echo "::group::triplere-recovery-list"
gcc -O2 -Wall -Wextra -Werror -o "$OUT/triplere-recovery-list.exe" "$HERE/recovery-list.c" \
  $(pkg-config --cflags --libs libirecovery-1.0)
echo "::endgroup::"

for exe in idevice_id ideviceinfo idevicepair ideviceenterrecovery idevicerestore irecovery; do
  cp "$PREFIX/bin/$exe.exe" "$OUT/"
done

# Every DLL the tools load from the MSYS2 prefix (not Windows' own DLLs).
for exe in "$OUT"/*.exe; do
  ldd "$exe" | awk '{print $3}' | grep -i "^$PREFIX/bin/.*\.dll$" || true
done | sort -u | while read -r dll; do cp "$dll" "$OUT/"; done

cat >> "$OUT/licenses/SOURCES.txt" <<'EOF'

These programs are used unmodified, as separate executables, under the GNU Lesser General Public
License (LGPL-2.1 / LGPL-3.0, see the COPYING files here). The exact source code of each is at the
address above. The MinGW runtime DLLs come from MSYS2 (https://packages.msys2.org).
EOF
ls -la "$OUT"
