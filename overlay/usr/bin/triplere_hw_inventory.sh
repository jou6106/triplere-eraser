#!/bin/sh
# Triple Re hardware inventory for ShredOS.
#
# Runs once at boot, before nwipe starts. It only READS hardware information
# (lshw, dmidecode, /sys, /proc) and writes it to /nwipe_log_hwinventory_*.txt.
# ShredOS' archive_log.sh copies every /nwipe_log* file to the USB drive, so the
# inventory lands next to nwipe's own log and PDF reports with no extra step.
#
# The file is plain text split into "### <section>" blocks; the Triple Re ERP
# parses it when the technician uploads the nwipe files.

OUT="${TRIPLERE_OUT_DIR:-}/nwipe_log_hwinventory_$(date +%Y%m%d-%H%M%S).txt"
TMP="/tmp/triplere_lshw.json"
LSHW_TIMEOUT=90

say() {
    # tty1 is where nwipe appears; the message is visible until nwipe starts.
    [ -w /dev/tty1 ] && printf '%s\n' "$1" > /dev/tty1
}

section() {
    echo
    echo "### $1"
}

say ""
say "  Triple Re - collecting hardware inventory, please wait..."

# lshw can take a while on some machines; never let it block nwipe forever.
rm -f "$TMP"
( lshw -json -quiet > "$TMP" 2>/dev/null ) &
LSHW_PID=$!
waited=0
while kill -0 "$LSHW_PID" 2>/dev/null && [ "$waited" -lt "$LSHW_TIMEOUT" ]; do
    sleep 1
    waited=$((waited + 1))
done
kill "$LSHW_PID" 2>/dev/null

{
    echo "### TRIPLERE-HWINVENTORY v1"
    echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "system_uuid=$(dmidecode -s system-uuid 2>/dev/null)"
    echo "system_serial=$(dmidecode -s system-serial-number 2>/dev/null)"
    echo "lshw_seconds=$waited"

    section "lshw-json"
    [ -s "$TMP" ] && cat "$TMP"

    section "dmidecode-system"
    dmidecode -t 1 2>/dev/null

    section "dmidecode-chassis"
    dmidecode -t 3 2>/dev/null

    section "dmidecode-memory"
    dmidecode -t 17 2>/dev/null

    section "cpuinfo"
    grep -m1 "model name" /proc/cpuinfo
    echo "logical_cpus=$(grep -c '^processor' /proc/cpuinfo)"
    grep -m1 "cpu cores" /proc/cpuinfo

    section "meminfo"
    grep -m1 MemTotal /proc/meminfo

    section "power-supply"
    for supply in /sys/class/power_supply/*; do
        [ -e "$supply/uevent" ] || continue
        echo "[$(basename "$supply")]"
        cat "$supply/uevent"
    done

    section "network"
    for iface in /sys/class/net/*; do
        [ -e "$iface" ] || continue
        name=$(basename "$iface")
        [ "$name" = "lo" ] && continue
        kind="Ethernet"
        { [ -d "$iface/wireless" ] || [ -e "$iface/phy80211" ]; } && kind="Wireless"
        driver=$(basename "$(readlink "$iface/device/driver" 2>/dev/null)" 2>/dev/null)
        echo "$name|$(cat "$iface/address" 2>/dev/null)|$kind|$driver"
    done

    section "presence"
    present() { [ -n "$(ls $1 2>/dev/null)" ] && echo 1 || echo 0; }
    echo "webcam=$(present '/sys/class/video4linux/video*')"
    echo "bluetooth=$(present '/sys/class/bluetooth/hci*')"
    echo "wifi=$(present '/sys/class/net/*/wireless /sys/class/net/*/phy80211')"
    echo "battery=$(present '/sys/class/power_supply/BAT*')"
    echo "sound=$(present '/sys/class/sound/card*')"
    echo "internal_display=$(present '/sys/class/drm/card*-eDP-* /sys/class/drm/card*-LVDS-* /sys/class/drm/card*-DSI-*')"
    echo "usb_hubs=$(ls -d /sys/bus/usb/devices/usb* 2>/dev/null | wc -l)"

    section "input-devices"
    grep '^N: Name=' /proc/bus/input/devices 2>/dev/null

    section "lspci"
    lspci 2>/dev/null

    section "lsusb"
    lsusb 2>/dev/null
} > "$OUT" 2>/dev/null

rm -f "$TMP"
say "  Triple Re - hardware inventory saved: $(basename "$OUT")"
exit 0
