#!/bin/bash
# Applies the Triple Re Eraser changes to a ShredOS source tree:
#   ./apply.sh /path/to/shredos.x86_64
# Every edit to an upstream file checks that its anchor exists exactly once, so a
# ShredOS update that moves things fails the build instead of silently skipping.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
SHREDOS="$(cd "${1:?usage: apply.sh <shredos source dir>}" && pwd)"
cd "$SHREDOS"

VERSION="2025.11_32_x86-64_v0.43.1_TripleRe"

# Inserts <line> before (or after) the single line equal to <anchor>.
insert_line() {
    local file="$1" where="$2" anchor="$3" line="$4"
    python3 - "$file" "$where" "$anchor" "$line" <<'PY'
import sys
path, where, anchor, line = sys.argv[1:]
lines = open(path).read().split("\n")
hits = [i for i, l in enumerate(lines) if l == anchor]
if len(hits) != 1:
    sys.exit(f"apply.sh: expected 1 match for {anchor!r} in {path}, found {len(hits)}")
i = hits[0] if where == "before" else hits[0] + 1
lines.insert(i, line)
open(path, "w").write("\n".join(lines))
PY
}

echo ">> Triple Re: overlay scripts"
cp -R "$SRC/overlay/." board/shredos/fsoverlay/
chmod 0755 board/shredos/fsoverlay/usr/bin/triplere_*.sh board/shredos/fsoverlay/etc/init.d/S95triplere_inventory

echo ">> Triple Re: licence public key"
# Only the public key goes in the image; licences are signed by the ERP's private key.
grep -q 'BEGIN PUBLIC KEY' "$SRC/config/license_public.pem"
mkdir -p board/shredos/fsoverlay/etc/triplere
cp "$SRC/config/license_public.pem" board/shredos/fsoverlay/etc/triplere/license_public.pem

echo ">> Triple Re: remove the root shell on tty2 (it could start nwipe without a licence)"
python3 - board/shredos/fsoverlay/etc/inittab <<'PY'
import sys
path = sys.argv[1]
line = "2:3:respawn:/sbin/getty 38400 tty2 -n -l /bin/sh"
lines = open(path).read().split("\n")
if lines.count(line) != 1:
    sys.exit(f"apply.sh: tty2 shell line not found exactly once in {path}")
open(path, "w").write("\n".join(l for l in lines if l != line))
PY

echo ">> Triple Re: build options"
cat "$SRC/config/defconfig.fragment" >> configs/shredos_defconfig
cp "$SRC/config/busybox.fragment" board/shredos/triplere-busybox.fragment
cat "$SRC/config/kernel.fragment" >> board/shredos/kernel-defconfig

echo ">> Triple Re: version / branding"
# version.txt names the .img and lets ShredOS recognise its own USB drive; all copies come from this file.
printf '%s\n' "$VERSION" > board/shredos/fsoverlay/etc/shredos/version.txt
# nwipe title bar: "Triple Re Eraser - ShredOS v<version>"
grep -q 'ShredOS v\$version' package/nwipe/002-nwipe-banner-patch.sh
sed -i 's/ShredOS v\$version/Triple Re Eraser - ShredOS v$version/' package/nwipe/002-nwipe-banner-patch.sh

echo ">> Triple Re: hooks in nwipe_launcher"
LAUNCHER=board/shredos/fsoverlay/usr/bin/nwipe_launcher
insert_line "$LAUNCHER" before $'\t\tif [ $nwipe_options_flag == 0 ]' \
    $'\t\t# Triple Re: network / Wi-Fi screen before the wipe\n\t\t[ -x /usr/bin/triplere_prewipe.sh ] && /usr/bin/triplere_prewipe.sh'
insert_line "$LAUNCHER" after $'\t\t/usr/bin/archive_log.sh -w' \
    $'\t\t# Triple Re: show whether the reports reached the ERP\n\t\t[ -x /usr/bin/triplere_postwipe.sh ] && /usr/bin/triplere_postwipe.sh'

echo ">> Triple Re: ERP key + saved Wi-Fi in archive_log.sh"
insert_line board/shredos/fsoverlay/usr/bin/archive_log.sh before '# unmount the FAT32 drive' "$(cat <<'BLOCK'
# Triple Re: the ERP upload key and saved Wi-Fi networks live in /etc/triplere on the USB drive.
if [[ "$mode" == "read" ]] && [ -d "$archive_drive_directory/etc/triplere" ]; then
    mkdir -p /etc/triplere
    cp "$archive_drive_directory"/etc/triplere/*.conf /etc/triplere/ 2>/dev/null
    printf "[`date "$date_format"`] archive_log.sh: Copied Triple Re settings from $drive_partition:/etc/triplere\n" 2>&1 | tee -a transfer.log
fi
if [[ "$mode" == "write" ]] && ls /etc/triplere/*.conf >/dev/null 2>&1; then
    # upload.conf (renewed or removed licence) and wifi.conf (saved networks)
    mkdir -p "$archive_drive_directory/etc/triplere"
    cp /etc/triplere/*.conf "$archive_drive_directory/etc/triplere/"
fi
BLOCK
)"

echo ">> Triple Re: changes applied"
