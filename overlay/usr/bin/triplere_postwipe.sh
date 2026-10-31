#!/bin/bash
# Triple Re post-wipe screen (runs on tty1 from nwipe_launcher after nwipe exits
# and ShredOS has copied the logs/PDFs to the USB drive).
# Waits for the background uploader and tells the technician where the reports went.

STATUS=/nwipe_log_upload_status.txt
BACKTITLE="Triple Re Eraser  |  NIST SP 800-88  |  nwipe / ShredOS"
WAIT_SECONDS=180

latest_log=$(ls -t /nwipe_log_2*.txt 2>/dev/null | head -n 1)
[ -n "$latest_log" ] || exit 0
name=$(basename "$latest_log")

final_line() {
    grep -F "$name" "$STATUS" 2>/dev/null | grep -E 'Uploaded to ERP|saved on USB only' | tail -n 1
}

waited=0
result=$(final_line)
while [ -z "$result" ] && [ "$waited" -lt "$WAIT_SECONDS" ]; do
    dialog --backtitle "$BACKTITLE" --title "Triple Re ERP" \
        --infobox "Uploading the wipe reports to the Triple Re ERP...\n\n($waited s)" 8 60 2>/dev/null
    sleep 3
    waited=$((waited + 3))
    result=$(final_line)
done

if printf '%s' "$result" | grep -q 'Uploaded to ERP'; then
    text="Reports uploaded to the Triple Re ERP.\n\nA copy is also saved on the USB drive."
else
    text="The reports could not be uploaded now.\n\nThey are saved on the USB drive - upload them from the\n\"Data Erasure Certificates\" page in the ERP."
fi

# Save the upload status file on the USB drive too.
/usr/bin/archive_log.sh -w >/dev/null 2>&1

dialog --backtitle "$BACKTITLE" --title "Triple Re ERP" --timeout 30 --msgbox "$text" 10 64 2>/dev/null \
    || printf '\n%b\n' "$text"
clear
exit 0
