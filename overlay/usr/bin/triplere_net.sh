#!/bin/bash
# Triple Re network helpers: cable / Wi-Fi state, scan, connect, saved networks, clock sync.
#
# Sourced by triplere_prewipe.sh (text screens) and run as a command by the graphical
# screens, so both use the same code:
#   triplere_net.sh status          -> online=0|1 wired=0|1 wifi=<iface> ssid=<name>
#   triplere_net.sh scan            -> "signal<TAB>secured<TAB>ssid" per line, strongest first
#   triplere_net.sh connect-saved   -> exit 0 when connected with a saved network
#   triplere_net.sh connect <ssid>  -> password on stdin (empty = open network); exit 0 ok,
#                                      1 failed, 3 password not 8-63 characters
#   triplere_net.sh save-last       -> keeps the last connected network on the USB drive
#   triplere_net.sh sync-clock
#
# Saved networks: /etc/triplere/wifi.conf (wpa_supplicant network blocks). archive_log.sh
# copies it from/to the USB drive, so a network saved once is reused on every laptop.

CONF_DIR=/etc/triplere
SAVED="$CONF_DIR/wifi.conf"
RUN_CONF=/tmp/triplere_wpa.conf
LAST_BLOCK=/tmp/triplere_last_network.conf
WPA_PID=/tmp/triplere_wpa.pid
DHCP_PID=/tmp/triplere_udhcpc.pid

online() { ip route 2>/dev/null | grep -q '^default'; }

wifi_iface() {
    for path in /sys/class/net/*; do
        if [ -d "$path/wireless" ] || [ -e "$path/phy80211" ]; then
            basename "$path"
            return
        fi
    done
}

sync_clock() {
    # HTTPS uploads fail when the laptop clock is wrong (dead CMOS battery).
    command -v ntpd >/dev/null 2>&1 || return 0
    if command -v timeout >/dev/null 2>&1; then
        timeout 15 ntpd -n -q -p pool.ntp.org -p time.google.com >/dev/null 2>&1
    fi
}

stop_wifi() {
    [ -f "$DHCP_PID" ] && kill "$(cat "$DHCP_PID")" 2>/dev/null
    [ -f "$WPA_PID" ] && kill "$(cat "$WPA_PID")" 2>/dev/null
    rm -f "$DHCP_PID" "$WPA_PID"
    sleep 1
}

# connect <iface> <wpa-conf>
connect() {
    local iface="$1" conf="$2" n
    stop_wifi
    for soft in /sys/class/rfkill/*/soft; do [ -w "$soft" ] && echo 0 > "$soft"; done
    ip link set "$iface" up 2>/dev/null
    wpa_supplicant -B -i "$iface" -c "$conf" -D nl80211 -P "$WPA_PID" >/dev/null 2>&1 || return 1
    for n in $(seq 1 25); do
        wpa_cli -i "$iface" status 2>/dev/null | grep -q '^wpa_state=COMPLETED' && break
        sleep 1
    done
    wpa_cli -i "$iface" status 2>/dev/null | grep -q '^wpa_state=COMPLETED' || return 1
    # udhcpc daemonizes after getting a lease and keeps renewing it; -n = give up if no lease.
    udhcpc -i "$iface" -n -t 10 -T 2 -p "$DHCP_PID" >/dev/null 2>&1 || return 1
    online
}

conf_header() {
    printf 'ctrl_interface=/var/run/wpa_supplicant\nupdate_config=0\ncountry=EG\n\n'
}

# network_block <ssid> <password or empty>
network_block() {
    local ssid_hex
    ssid_hex=$(printf '%s' "$1" | od -An -tx1 | tr -d ' \n')
    if [ -z "$2" ]; then
        printf 'network={\n\tssid=%s\n\tkey_mgmt=NONE\n}\n' "$ssid_hex"
    else
        local psk
        psk=$(wpa_passphrase "$1" "$2" 2>/dev/null | sed -n 's/^[[:space:]]*psk=\([0-9a-f]\{64\}\)$/\1/p')
        [ -n "$psk" ] || return 1
        printf 'network={\n\tssid=%s\n\tpsk=%s\n\tkey_mgmt=WPA-PSK WPA-PSK-SHA256\n\tieee80211w=1\n}\n' "$ssid_hex" "$psk"
    fi
}

# Prints "signal<TAB>secured<TAB>ssid", strongest first, one line per network name.
scan() {
    local iface="$1" attempt
    ip link set "$iface" up 2>/dev/null
    for attempt in 1 2 3; do
        local found
        found=$(iw dev "$iface" scan 2>/dev/null | awk '
            /^BSS / { if (ssid != "") print sig "\t" sec "\t" ssid; ssid = ""; sig = -100; sec = 0 }
            /^\tsignal:/ { sig = int($2) }
            /^\tSSID: / { sub(/^\tSSID: /, ""); ssid = $0 }
            /^\t(RSN|WPA):/ { sec = 1 }
            /capability:.*Privacy/ { sec = 1 }
            END { if (ssid != "") print sig "\t" sec "\t" ssid }
        ' | sort -t "$(printf '\t')" -k1,1nr | awk -F '\t' '!seen[$3]++')
        if [ -n "$found" ]; then
            printf '%s\n' "$found"
            return 0
        fi
        sleep 2
    done
}

current_ssid() {
    local iface
    iface=$(wifi_iface)
    [ -n "$iface" ] && wpa_cli -i "$iface" status 2>/dev/null | sed -n 's/^ssid=//p'
}

# Connects with the networks saved on the USB drive.
connect_saved() {
    local iface
    iface=$(wifi_iface)
    [ -n "$iface" ] && [ -s "$SAVED" ] || return 1
    { conf_header; cat "$SAVED"; } > "$RUN_CONF"
    if connect "$iface" "$RUN_CONF"; then
        return 0
    fi
    stop_wifi
    return 1
}

# connect_new <ssid> <password>: 0 connected, 1 failed, 3 bad password length
connect_new() {
    local iface block
    iface=$(wifi_iface)
    [ -n "$iface" ] || return 1
    block=$(network_block "$1" "$2") || return 3
    { conf_header; printf '%s\n' "$block"; } > "$RUN_CONF"
    if connect "$iface" "$RUN_CONF"; then
        printf '%s\n' "$block" > "$LAST_BLOCK"
        return 0
    fi
    stop_wifi
    return 1
}

save_last() {
    [ -s "$LAST_BLOCK" ] || return 1
    mkdir -p "$CONF_DIR"
    cat "$LAST_BLOCK" >> "$SAVED"
}

# ---- command mode (not when sourced) --------------------------------------------------
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    case "$1" in
        status)
            if online; then echo "online=1"; else echo "online=0"; fi
            iface=$(wifi_iface)
            echo "wifi=$iface"
            ssid=$(current_ssid)
            echo "ssid=$ssid"
            # online without Wi-Fi association = cable
            if online && [ -z "$ssid" ]; then echo "wired=1"; else echo "wired=0"; fi
            ;;
        scan)
            iface=$(wifi_iface)
            [ -n "$iface" ] || exit 1
            scan "$iface"
            ;;
        connect-saved)
            connect_saved
            ;;
        connect)
            [ -n "$2" ] || exit 1
            IFS= read -r password || true
            connect_new "$2" "$password"
            ;;
        save-last)
            save_last
            ;;
        sync-clock)
            sync_clock
            ;;
        *)
            echo "usage: $0 status|scan|connect-saved|connect <ssid>|save-last|sync-clock" >&2
            exit 2
            ;;
    esac
fi
