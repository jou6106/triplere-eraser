#!/bin/bash
# Triple Re post-wipe screen (runs on tty1 from nwipe_launcher after nwipe exits
# and ShredOS has copied the logs/PDFs to the USB drive).
# Uploads the reports now (foreground) and tells the technician where they went.

STATUS=/nwipe_log_upload_status.txt
BACKTITLE="Triple Re Eraser  |  NIST SP 800-88"

# archive_log.sh -w has already moved the copied logs from / to /sent.
latest_log=$(ls -t /nwipe_log_[0-9]*.txt /sent/nwipe_log_[0-9]*.txt 2>/dev/null | head -n 1)
[ -n "$latest_log" ] || exit 0
name=$(basename "$latest_log")

final_line() {
    grep -F "$name" "$STATUS" 2>/dev/null | grep -E 'Uploaded to ERP|saved on USB only' | tail -n 1
}

dialog --backtitle "$BACKTITLE" --title "Triple Re ERP" \
    --infobox "Uploading the wipe reports to the Triple Re ERP...\n\nThis can take up to 2 minutes." 8 60 2>/dev/null
/usr/bin/triplere_uploader.sh
result=$(final_line)

if printf '%s' "$result" | grep -q 'Uploaded to ERP'; then
    text="Reports uploaded to the Triple Re ERP.\n\nA copy is also saved on the USB drive.\n\nIt is now safe to power off."
else
    text="The reports could not be uploaded now.\n\nThey are saved on the USB drive - upload them from the\n\"Data Erasure Certificates\" page in the ERP.\n\nIt is now safe to power off."
fi

# No second archive_log.sh here: nwipe_launcher already copied the logs and PDFs to the
# USB drive, and copying them again meant a power-off during the copy truncated files
# that were already safe (seen in the field: 0-byte logs and broken PDFs).
sync

dialog --backtitle "$BACKTITLE" --title "Triple Re ERP" --timeout 30 --msgbox "$text" 10 64 2>/dev/null \
    || printf '\n%b\n' "$text"
clear
exit 0
