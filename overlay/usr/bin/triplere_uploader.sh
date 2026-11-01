#!/bin/sh
# Triple Re automatic upload for ShredOS.
#
# Run by triplere_postwipe.sh right after nwipe exits. Uploads every finished
# session of this boot that was not uploaded yet, then exits. A session is
# finished when its log has the summary ("Total Throughput", after an overwrite)
# or a successful firmware sanitize (nwipe 0.43 writes no summary for those).
#
# Nothing here blocks or changes the wipe:
#   - ShredOS still copies every log and PDF to the USB drive (archive_log.sh).
#   - No network, no config or a failed upload => the files simply stay on the USB
#     and can be uploaded from the ERP page by hand.
#   - Stock ShredOS has no HTTPS client; without curl this script exits quietly.
#
# Config (copied from the USB drive at boot): /etc/triplere/upload.conf
#   ERP_URL="https://erp.triplere.net/api/erasure/upload"
#   UPLOAD_TOKEN="tre_..."

CONF="${TRIPLERE_CONF:-/etc/triplere/upload.conf}"
ROOT="${TRIPLERE_ROOT:-}"
DONE_LIST="${TRIPLERE_DONE_LIST:-/tmp/triplere_uploaded.list}"
STATUS="${ROOT}/nwipe_log_upload_status.txt"
ATTEMPTS=6
RETRY_SECONDS=20

command -v curl >/dev/null 2>&1 || exit 0
touch "$DONE_LIST"

status() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$STATUS"
}

already_done() {
    grep -qxF "$1" "$DONE_LIST"
}

upload_session() {
    log="$1"

    if [ ! -r "$CONF" ]; then
        status "No upload config ($CONF) - files saved on USB only: $(basename "$log")"
        return 0
    fi

    # No route at all (no cable, Wi-Fi skipped): give the network 30s, then stop trying.
    if [ -z "${TRIPLERE_SKIP_ROUTE_CHECK:-}" ]; then
        waited=0
        while ! ip route 2>/dev/null | grep -q '^default' && [ "$waited" -lt 30 ]; do
            sleep 3
            waited=$((waited + 3))
        done
        if ! ip route 2>/dev/null | grep -q '^default'; then
            status "No network - files saved on USB only: $(basename "$log")"
            return 0
        fi
    fi
    # Plain-data read: the file comes from the USB drive and is never executed.
    ERP_URL=$(sed -n 's/^ERP_URL="\([^"$`\\]*\)"[[:space:]]*$/\1/p' "$CONF" | tail -n 1)
    UPLOAD_TOKEN=$(sed -n 's/^UPLOAD_TOKEN="\([^"$`\\]*\)"[[:space:]]*$/\1/p' "$CONF" | tail -n 1)
    if [ -z "$ERP_URL" ] || [ -z "$UPLOAD_TOKEN" ]; then
        status "Upload config incomplete - files saved on USB only: $(basename "$log")"
        return 0
    fi

    # Build the multipart form: log + newest inventory + PDFs not uploaded yet.
    set -- -F "log_file=@${log}"
    inventory=$(ls -t "${ROOT}"/nwipe_log_hwinventory_*.txt 2>/dev/null | head -n 1)
    [ -n "$inventory" ] && set -- "$@" -F "inventory_file=@${inventory}"
    pdfs=""
    for pdf in "${ROOT}"/nwipe_report_*.pdf; do
        [ -f "$pdf" ] || continue
        already_done "$pdf" && continue
        set -- "$@" -F "pdf_files[]=@${pdf}"
        pdfs="$pdfs $pdf"
    done

    CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
    [ -r "$CA_BUNDLE" ] && set -- --cacert "$CA_BUNDLE" "$@"

    attempt=1
    while [ "$attempt" -le "$ATTEMPTS" ]; do
        response=$(curl -sS --connect-timeout 15 --max-time 600 \
            -H "Authorization: Bearer ${UPLOAD_TOKEN}" -H "Accept: application/json" \
            -w '\nHTTP_STATUS=%{http_code}' "$@" "$ERP_URL" 2>&1)
        code=$(printf '%s' "$response" | sed -n 's/^HTTP_STATUS=//p')
        # Only a JSON {"ok":true} from the ERP counts: a proxy or PHP error page can also return 200.
        if [ "$code" = 200 ] || [ "$code" = 201 ]; then
            printf '%s' "$response" | grep -q '"ok":true' || code="${code}-unexpected"
        fi
        case "$code" in
            200|201)
                status "Uploaded to ERP: $(basename "$log") $(printf '%s' "$response" | head -n 1)"
                for pdf in $pdfs; do echo "$pdf" >> "$DONE_LIST"; done
                return 0
                ;;
            401|422)
                # Rejected key or files: retrying will not help.
                status "ERP rejected the upload (HTTP $code) - files saved on USB only: $(basename "$log") $(printf '%s' "$response" | head -n 1)"
                return 0
                ;;
        esac
        status "Upload attempt $attempt/$ATTEMPTS failed (HTTP ${code:-none}) - retrying in ${RETRY_SECONDS}s"
        attempt=$((attempt + 1))
        sleep "$RETRY_SECONDS"
    done

    status "No connection to the ERP - files saved on USB only: $(basename "$log")"
    return 0
}

# nwipe logs are nwipe_log_<date>.txt (any year: a dead CMOS clock gives 2019 or 1970);
# the inventory and status files start with nwipe_log_hw / nwipe_log_up and are skipped.
for log in "${ROOT}"/nwipe_log_[0-9]*.txt; do
    [ -f "$log" ] || continue
    already_done "$log" && continue
    grep -qE "Total Throughput|SANITIZE action '[^']+' was successful" "$log" || continue
    upload_session "$log"
    echo "$log" >> "$DONE_LIST"
done
exit 0
