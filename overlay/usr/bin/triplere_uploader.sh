#!/bin/sh
# Triple Re automatic upload to the ERP.
#
# Run right after a wipe (by the graphical screens or triplere_postwipe.sh). Uploads every
# finished session of this boot that was not uploaded yet, then exits. A session is
# finished when its log has the summary ("Total Throughput", after an overwrite) or a
# successful firmware sanitize.
#
# Where the files are: the eraser writes logs and PDFs to /, and archive_log.sh -w (which
# copies them to the USB drive) then MOVES them to /sent. Both places are searched; the
# upload used to look in / only and so found nothing after the copy to the USB drive.
#
# Nothing here blocks or changes the wipe:
#   - Every log and PDF is still copied to the USB drive (archive_log.sh).
#   - No network, no config or a failed upload => the files simply stay on the USB
#     and can be uploaded from the ERP page by hand.
#
# Config (copied from the USB drive at boot): /etc/triplere/upload.conf
#   ERP_URL="https://erp.triplere.net/api/erasure/upload"
#   UPLOAD_TOKEN="tre_..."
# Job details typed on the graphical screens (optional): /etc/triplere/job.conf
#   CLIENT_NAME="..."  TECHNICIAN_NAME="..."  WORK_ORDER="..."

CONF="${TRIPLERE_CONF:-/etc/triplere/upload.conf}"
JOB_CONF="${TRIPLERE_JOB_CONF:-/etc/triplere/job.conf}"
ROOT="${TRIPLERE_ROOT:-}"
DONE_LIST="${TRIPLERE_DONE_LIST:-/tmp/triplere_uploaded.list}"
STATUS="${ROOT}/nwipe_log_upload_status.txt"
ATTEMPTS="${TRIPLERE_ATTEMPTS:-6}"
RETRY_SECONDS="${TRIPLERE_RETRY_SECONDS:-20}"
MAX_PDFS=50
# Set once the ERP could not be reached, so the other sessions of this run do not each wait again.
GIVE_UP=""
# File names are split on newlines only.
NL='
'
IFS="$NL"

command -v curl >/dev/null 2>&1 || exit 0
touch "$DONE_LIST"

status() {
    printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$STATUS"
}

already_done() {
    grep -qxF "$(basename "$1")" "$DONE_LIST"
}

mark_done() {
    basename "$1" >> "$DONE_LIST"
}

# Plain-data read of KEY="value": the files come from the USB drive and are never executed.
conf_value() {
    sed -n "s/^$1=\"\([^\"\$\`\\\\]*\)\"[[:space:]]*\$/\1/p" "$2" 2>/dev/null | tail -n 1
}

# Newest first, so the ERP matches a re-wiped disk to its latest report.
list_files() {
    ls -t "${ROOT}"/$1 "${ROOT}"/sent/$1 2>/dev/null
}

upload_session() {
    log="$1"

    if [ ! -r "$CONF" ]; then
        status "No upload config ($CONF) - files saved on USB only: $(basename "$log")"
        return 0
    fi

    if [ -n "$GIVE_UP" ]; then
        status "$GIVE_UP - files saved on USB only: $(basename "$log")"
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
            GIVE_UP="No network"
            status "No network - files saved on USB only: $(basename "$log")"
            return 0
        fi
    fi
    ERP_URL=$(conf_value ERP_URL "$CONF")
    UPLOAD_TOKEN=$(conf_value UPLOAD_TOKEN "$CONF")
    if [ -z "$ERP_URL" ] || [ -z "$UPLOAD_TOKEN" ]; then
        status "Upload config incomplete - files saved on USB only: $(basename "$log")"
        return 0
    fi

    # The multipart form: log + newest inventory + this boot's PDF reports + job details.
    # The ERP picks the PDF of each erased disk by serial number and device name.
    set -- -F "log_file=@${log}"
    inventory=$(list_files 'nwipe_log_hwinventory_*.txt' | head -n 1)
    [ -n "$inventory" ] && set -- "$@" -F "inventory_file=@${inventory}"
    count=0
    for pdf in $(list_files 'nwipe_report_*.pdf'); do
        [ -s "$pdf" ] || continue
        [ "$count" -lt "$MAX_PDFS" ] || break
        set -- "$@" -F "pdf_files[]=@${pdf}"
        count=$((count + 1))
    done
    if [ -r "$JOB_CONF" ]; then
        for field in client_name technician_name work_order; do
            value=$(conf_value "$(echo "$field" | tr 'a-z' 'A-Z')" "$JOB_CONF")
            [ -n "$value" ] && set -- "$@" --form-string "${field}=${value}"
        done
    fi

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
            printf '%s' "$response" | grep -qE '"ok": ?true' || code="${code}-unexpected"
        fi
        case "$code" in
            200|201)
                status "Uploaded to ERP: $(basename "$log") $(printf '%s' "$response" | head -n 1)"
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
        [ "$attempt" -le "$ATTEMPTS" ] && sleep "$RETRY_SECONDS"
    done

    GIVE_UP="No connection to the ERP"
    status "No connection to the ERP - files saved on USB only: $(basename "$log")"
    return 0
}

# Session logs are nwipe_log_<date>.txt (any year: a dead CMOS clock gives 2019 or 1970);
# the inventory, upload status and error files start with nwipe_log_<letter> and are skipped.
for log in $(list_files 'nwipe_log_[0-9]*.txt'); do
    [ -f "$log" ] || continue
    already_done "$log" && continue
    grep -qE "Total Throughput|SANITIZE action '[^']+' was successful" "$log" || continue
    before=$(grep -c . "$STATUS" 2>/dev/null || echo 0)
    upload_session "$log"
    # Only a successful upload is final; anything else is retried on the next run.
    if tail -n +$((before + 1)) "$STATUS" 2>/dev/null | grep -qF "Uploaded to ERP: $(basename "$log")"; then
        mark_done "$log"
    fi
done
exit 0
