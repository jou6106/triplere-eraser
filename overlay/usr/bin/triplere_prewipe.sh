#!/bin/bash
# Triple Re pre-wipe screen (runs on tty1 from nwipe_launcher, right before nwipe).
#
# Shows the network state and lets the technician connect to Wi-Fi so the
# wipe reports can be uploaded to the Triple Re ERP afterwards. It never blocks
# the wipe: with no input for 30 seconds it continues offline, and offline the
# reports are simply saved on the USB drive as usual.
#
# Saved networks: /etc/triplere/wifi.conf (wpa_supplicant network blocks).
# archive_log.sh copies it from/to the USB drive, so a network saved once is
# reused on every laptop.

CONF_DIR=/etc/triplere
SAVED="$CONF_DIR/wifi.conf"
RUN_CONF=/tmp/triplere_wpa.conf
WPA_PID=/tmp/triplere_wpa.pid
DHCP_PID=/tmp/triplere_udhcpc.pid
BACKTITLE="Triple Re Eraser  |  NIST SP 800-88  |  nwipe / ShredOS"
MENU_TIMEOUT=30

have_dialog() { command -v dialog >/dev/null 2>&1; }

online() { ip route 2>/dev/null | grep -q '^default'; }

wifi_iface() {
    for path in /sys/class/net/*; do
        if [ -d "$path/wireless" ] || [ -e "$path/phy80211" ]; then
            basename "$path"
            return
        fi
    done
}

info() {
    # info <title> <text> [seconds]
    if have_dialog; then
        dialog --backtitle "$BACKTITLE" --title "$1" --infobox "$2" 8 64
    else
        printf '\n== %s ==\n%s\n' "$1" "$2"
    fi
    sleep "${3:-2}"
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

choose_and_connect() {
    local iface="$1" list ssid secured password args=() i=1 choice line
    info "Wi-Fi" "Searching for Wi-Fi networks..." 0
    list=$(scan "$iface")
    if [ -z "$list" ]; then
        dialog --backtitle "$BACKTITLE" --title "Wi-Fi" --timeout 15 --msgbox "No Wi-Fi networks found." 7 50
        return 1
    fi
    while IFS=$'\t' read -r sig sec name; do
        args+=("$i" "$(printf '%-32.32s %4s dBm %s' "$name" "$sig" "$([ "$sec" = 1 ] && echo '[locked]')")")
        i=$((i + 1))
    done <<< "$list"

    choice=$(dialog --backtitle "$BACKTITLE" --title "Choose Wi-Fi network" --stdout \
        --menu "Select the network to upload reports to the Triple Re ERP:" 20 72 12 "${args[@]}") || return 1
    line=$(printf '%s\n' "$list" | sed -n "${choice}p")
    secured=$(printf '%s' "$line" | cut -f2)
    ssid=$(printf '%s' "$line" | cut -f3-)

    password=""
    if [ "$secured" = 1 ]; then
        password=$(dialog --backtitle "$BACKTITLE" --title "Wi-Fi password" --stdout --insecure \
            --passwordbox "Password for \"$ssid\":" 9 60) || return 1
    fi

    local block
    if ! block=$(network_block "$ssid" "$password"); then
        dialog --backtitle "$BACKTITLE" --title "Wi-Fi" --msgbox "Wi-Fi passwords must be 8 to 63 characters." 7 54
        return 1
    fi
    { conf_header; printf '%s\n' "$block"; } > "$RUN_CONF"

    info "Wi-Fi" "Connecting to \"$ssid\"..." 0
    if ! connect "$iface" "$RUN_CONF"; then
        stop_wifi
        dialog --backtitle "$BACKTITLE" --title "Wi-Fi" --timeout 20 --msgbox \
            "Could not connect to \"$ssid\".\nCheck the password and try again." 8 60
        return 1
    fi

    if dialog --backtitle "$BACKTITLE" --title "Wi-Fi" --timeout 15 --defaultno --yesno \
        "Connected to \"$ssid\".\n\nSave this network on the USB drive so other laptops connect automatically?" 9 64; then
        mkdir -p "$CONF_DIR"
        printf '%s\n' "$block" >> "$SAVED"
    fi
    return 0
}

main() {
    local iface
    iface=$(wifi_iface)

    if online; then
        sync_clock
        info "Network" "Connected (cable).\nReports will be uploaded to the Triple Re ERP after the wipe." 3
        return
    fi

    if [ -z "$iface" ] || ! command -v wpa_supplicant >/dev/null 2>&1 || ! have_dialog; then
        info "Network" "No network.\nReports will be saved on the USB drive." 3
        return
    fi

    if [ -s "$SAVED" ]; then
        info "Wi-Fi" "Connecting to the saved Wi-Fi network..." 0
        { conf_header; cat "$SAVED"; } > "$RUN_CONF"
        if connect "$iface" "$RUN_CONF"; then
            sync_clock
            info "Wi-Fi" "Connected to \"$(wpa_cli -i "$iface" status 2>/dev/null | sed -n 's/^ssid=//p')\".\nReports will be uploaded to the Triple Re ERP after the wipe." 3
            return
        fi
        stop_wifi
    fi

    while true; do
        choice=$(dialog --backtitle "$BACKTITLE" --title "Network" --stdout --timeout "$MENU_TIMEOUT" \
            --menu "No network connection.\nConnect to Wi-Fi to upload the reports to the Triple Re ERP,\nor continue and the reports will be saved on the USB drive.\n\n(Continues offline automatically after $MENU_TIMEOUT seconds.)" 16 72 2 \
            1 "Connect to Wi-Fi" \
            2 "Continue offline (save reports on the USB)") || choice=2
        if [ "$choice" = 1 ]; then
            if choose_and_connect "$iface"; then
                sync_clock
                info "Wi-Fi" "Online.\nReports will be uploaded to the Triple Re ERP after the wipe." 3
                return
            fi
        else
            info "Network" "Offline.\nReports will be saved on the USB drive." 2
            return
        fi
    done
}

main
clear
exit 0
