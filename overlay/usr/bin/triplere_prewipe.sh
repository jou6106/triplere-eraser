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

BACKTITLE="Triple Re Eraser  |  NIST SP 800-88"
MENU_TIMEOUT=30

# shellcheck source=triplere_net.sh
. /usr/bin/triplere_net.sh
# shellcheck source=triplere_license.sh
. /usr/bin/triplere_license.sh

have_dialog() { command -v dialog >/dev/null 2>&1; }

info() {
    # info <title> <text> [seconds]
    if have_dialog; then
        dialog --backtitle "$BACKTITLE" --title "$1" --infobox "$2" 8 64
    else
        printf '\n== %s ==\n%s\n' "$1" "$2"
    fi
    sleep "${3:-2}"
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

network_step() {
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
        if connect_saved; then
            sync_clock
            info "Wi-Fi" "Connected to \"$(current_ssid)\".\nReports will be uploaded to the Triple Re ERP after the wipe." 3
            return
        fi
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

# nwipe only starts with a valid licence from the Triple Re ERP. This screen does not
# time out on purpose: an unlicensed drive waits here until it is activated or powered off.
license_gate() {
    local state rc text choice disabled=0
    while true; do
        if online; then
            license_renew
            rc=$?
            if [ "$rc" -ne 1 ]; then
                # Save the renewed (or removed) licence on the USB drive.
                /usr/bin/archive_log.sh -w >/dev/null 2>&1
            fi
            [ "$rc" -eq 2 ] && disabled=1
        fi

        state=$(license_state)
        [ "$state" = valid ] && return 0

        case "$state" in
            expired) text="The licence of this USB drive has expired.\n\nConnect to the internet (cable or Wi-Fi) and choose Retry to renew it." ;;
            invalid) text="The licence on this USB drive is not valid.\n\nCreate a new key for it in the Triple Re ERP." ;;
            *)       text="This USB drive is not activated.\n\nCreate a key for it in the Triple Re ERP (Data Erasure Certificates page)\nand copy upload.conf to /etc/triplere/ on the USB drive." ;;
        esac
        [ "$disabled" = 1 ] && text="This USB drive has been disabled in the Triple Re ERP.\n\nContact the Triple Re administrator."

        if have_dialog; then
            choice=$(dialog --backtitle "$BACKTITLE" --title "Licence required" --stdout --no-cancel \
                --menu "$text" 16 74 3 \
                1 "Retry" \
                2 "Connect to Wi-Fi" \
                3 "Power off") || choice=1
        else
            printf '\n%b\n\n1) Retry  2) Connect to Wi-Fi  3) Power off\n> ' "$text"
            read -r choice
        fi
        case "$choice" in
            2) [ -n "$(wifi_iface)" ] && choose_and_connect "$(wifi_iface)" && sync_clock ;;
            3) clear; poweroff ;;
        esac
    done
}

network_step
license_gate
clear
exit 0
