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

echo ">> Triple Re: pinned Buildroot source fixes"
python3 "$SRC/scripts/fix-buildroot.py" "$SHREDOS"

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
chmod 0755 board/shredos/fsoverlay/usr/bin/triplere_*.sh board/shredos/fsoverlay/usr/bin/triplere_gui \
    board/shredos/fsoverlay/etc/init.d/S95triplere_inventory

echo ">> Triple Re: nwipe patch (--sanitize without the text screens, Triple Re name on the reports)"
# Buildroot applies package/<name>/*.patch to the downloaded nwipe source.
cp "$SRC"/patches/nwipe/*.patch package/nwipe/

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
# nwipe title bar (classic screen) and log: "Triple Re Eraser v<version>".
# The ERP reads the eraser version from this log line ("..._v0.43.1").
grep -q 'ShredOS v\$version' package/nwipe/002-nwipe-banner-patch.sh
sed -i 's/ShredOS v\$version/Triple Re Eraser v$version/' package/nwipe/002-nwipe-banner-patch.sh
grep -q 'Triple Re Eraser v\$version' package/nwipe/002-nwipe-banner-patch.sh

# Replaces exactly one line (or string) in a file, failing the build when it is not found once.
replace_once() {
    python3 - "$@" <<'PY2'
import sys
path, old, new = sys.argv[1:]
s = open(path).read()
n = s.count(old)
if n != 1:
    sys.exit(f"apply.sh: expected 1 match for {old!r} in {path}, found {n}")
open(path, "w").write(s.replace(old, new))
PY2
}

# Boot menu (BIOS and UEFI use the same grub.cfg). "classic screens" skips the graphical
# screens in case a laptop shows them badly; the erase itself is the same.
replace_once board/shredos/grub.cfg 'set timeout="15"' 'set timeout="5"'
replace_once board/shredos/grub.cfg 'menuentry "ShredOS" {
    linux /boot/bzImage console=tty3 loglevel=3
}' 'menuentry "Triple Re Eraser" {
    linux /boot/bzImage console=tty3 loglevel=3
}

menuentry "Triple Re Eraser (classic screens)" {
    linux /boot/bzImage console=tty3 loglevel=3 triplere_gui=off
}'
replace_once board/shredos/grub.cfg 'menuentry "ShredOS (nomodeset - display issues? try this)" {' \
    'menuentry "Triple Re Eraser (display problems? try this)" {'
# USB drive as seen from Windows / macOS: volume name, icon, autorun label, README
replace_once board/shredos/genimage.cfg '-F 32 -n SHREDOS' '-F 32 -n TRIPLERE'
replace_once board/shredos/genimage.cfg "file shredos.ico            { image = 'shredos.ico' }" \
    "file triplere.ico           { image = 'shredos.ico' }"
cp "$SRC/config/triplere.ico" board/shredos/shredos.ico
printf '[autorun]\r\nicon=triplere.ico\r\nlabel=Triple Re Eraser\r\n' > board/shredos/autorun.inf
cp "$SRC/config/README-USB.txt" board/shredos/README.txt
# Messages printed while the USB drive is read at boot
sed -i "s/ShredOS's ram disc/the RAM disc/g; s/ShredOS ram drive/the RAM disc/g" \
    board/shredos/fsoverlay/usr/bin/archive_log.sh
if grep -n 'printf.*ShredOS' board/shredos/fsoverlay/usr/bin/archive_log.sh; then
    echo "apply.sh: ShredOS still named in archive_log.sh messages" >&2
    exit 1
fi

echo ">> Triple Re: room for reports on the USB drive"
# ShredOS sizes the FAT partition as bzImage + 20 MB. With the Wi-Fi firmware the kernel
# image is ~314 MB, so the logs/PDFs/inventories of ~10 machines filled the drive and
# later sessions were written as 0-byte or truncated files. Leave ~2 GB free instead.
grep -q '^OFFSET=20000000$' board/shredos/make_img_file.sh
sed -i 's/^OFFSET=20000000$/OFFSET=2000000000/' board/shredos/make_img_file.sh

echo ">> Triple Re: hooks in nwipe_launcher"
LAUNCHER=board/shredos/fsoverlay/usr/bin/nwipe_launcher
# Graphical screens first. They only come back here for the classic text screens
# (technician's choice, or graphics not usable), which then run exactly as before.
insert_line "$LAUNCHER" before '# run nwipe with a time stamped log file' \
    $'# Triple Re: graphical screens (network, licence, disks, erase, reports)\n[ -x /usr/bin/triplere_gui ] && /usr/bin/triplere_gui\n'
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
