#!/bin/bash
# Triple Re Eraser licence check (sourced by triplere_prewipe.sh).
#
# /etc/triplere/upload.conf (copied from the USB drive at boot) holds:
#   LICENSE_ID, LICENSE_ISSUED, LICENSE_EXPIRES, LICENSE_SIG
# signed by the Triple Re ERP (ECDSA P-256 / SHA-256). Only the public key is in this image
# (/etc/triplere/license_public.pem), so a licence cannot be forged or extended
# by editing the USB drive. Online, the licence is renewed for another period;
# a stopped key in the ERP removes it and the drive stops working.

LICENSE_CONF="${LICENSE_CONF:-/etc/triplere/upload.conf}"
LICENSE_PUBKEY="${LICENSE_PUBKEY:-/etc/triplere/license_public.pem}"

# Reads KEY="value" from a config file as plain data. The file comes from the USB
# drive, so it is never executed (sourcing it would let anyone bypass the licence).
conf_get() {
    sed -n "s/^$1=\"\([^\"\\\$\`]*\)\"[[:space:]]*\$/\1/p" "$2" 2>/dev/null | tail -n 1
}

# Prints: valid | missing | invalid | expired
license_state() {
    [ -r "$LICENSE_CONF" ] || { echo missing; return; }
    local LICENSE_ID LICENSE_ISSUED LICENSE_EXPIRES LICENSE_SIG
    LICENSE_ID=$(conf_get LICENSE_ID "$LICENSE_CONF")
    LICENSE_ISSUED=$(conf_get LICENSE_ISSUED "$LICENSE_CONF")
    LICENSE_EXPIRES=$(conf_get LICENSE_EXPIRES "$LICENSE_CONF")
    LICENSE_SIG=$(conf_get LICENSE_SIG "$LICENSE_CONF")
    if [ -z "$LICENSE_ID" ] || [ -z "$LICENSE_SIG" ] || [ -z "$LICENSE_EXPIRES" ]; then
        echo missing
        return
    fi
    local date_re='^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    if ! [[ "$LICENSE_ID" =~ ^[0-9]+$ && "$LICENSE_ISSUED" =~ $date_re && "$LICENSE_EXPIRES" =~ $date_re ]]; then
        echo invalid
        return
    fi

    local data sig
    data=$(mktemp) sig=$(mktemp)
    printf 'triplere-license-v1|%s|%s|%s' "$LICENSE_ID" "$LICENSE_ISSUED" "$LICENSE_EXPIRES" > "$data"
    printf '%s' "$LICENSE_SIG" | openssl base64 -d -A > "$sig" 2>/dev/null
    if ! openssl dgst -sha256 -verify "$LICENSE_PUBKEY" -signature "$sig" "$data" >/dev/null 2>&1; then
        rm -f "$data" "$sig"
        echo invalid
        return
    fi
    rm -f "$data" "$sig"

    # Dates are YYYY-MM-DD, so a string comparison is a date comparison.
    if [[ "$(date -u +%Y-%m-%d)" > "$LICENSE_EXPIRES" ]]; then
        echo expired
        return
    fi
    echo valid
}

# Asks the ERP for a fresh licence. Returns 0 renewed, 1 no answer, 2 key stopped (licence removed).
license_renew() {
    local ERP_URL UPLOAD_TOKEN tmp code url
    [ -r "$LICENSE_CONF" ] || return 1
    ERP_URL=$(conf_get ERP_URL "$LICENSE_CONF")
    UPLOAD_TOKEN=$(conf_get UPLOAD_TOKEN "$LICENSE_CONF")
    [ -n "$ERP_URL" ] && [ -n "$UPLOAD_TOKEN" ] || return 1
    command -v curl >/dev/null 2>&1 || return 1

    [[ "$ERP_URL" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9/._-]*$ ]] || return 1
    url="${ERP_URL%/upload}/license"
    tmp=$(mktemp)
    code=$(curl -sS --connect-timeout 10 --max-time 30 -X POST \
        -H "Authorization: Bearer ${UPLOAD_TOKEN}" \
        ${CA_BUNDLE:+--cacert "$CA_BUNDLE"} \
        -o "$tmp" -w '%{http_code}' "$url" 2>/dev/null)

    case "$code" in
        200)
            if grep -qE '^LICENSE_SIG="[A-Za-z0-9+/=]+"$' "$tmp"; then
                { grep -v '^LICENSE_' "$LICENSE_CONF"; grep '^LICENSE_' "$tmp"; } > "$LICENSE_CONF.new" \
                    && mv "$LICENSE_CONF.new" "$LICENSE_CONF"
                rm -f "$tmp"
                return 0
            fi
            ;;
        401)
            # The key was stopped in the ERP: drop the licence so the drive stops working.
            grep -v '^LICENSE_' "$LICENSE_CONF" > "$LICENSE_CONF.new" && mv "$LICENSE_CONF.new" "$LICENSE_CONF"
            rm -f "$tmp"
            return 2
            ;;
    esac
    rm -f "$tmp"
    return 1
}

CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
[ -r "$CA_BUNDLE" ] || CA_BUNDLE=""

# ---- command mode for the graphical screens (not when sourced) ---------------------------
#   triplere_license.sh state  -> valid | missing | invalid | expired
#   triplere_license.sh renew  -> exit 0 renewed, 1 no answer, 2 key stopped (licence removed)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    case "$1" in
        state) license_state ;;
        renew) license_renew; exit $? ;;
        *) echo "usage: $0 state|renew" >&2; exit 2 ;;
    esac
fi
