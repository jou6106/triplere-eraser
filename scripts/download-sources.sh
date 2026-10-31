#!/bin/bash
# Run from the configured Buildroot tree. Preserve logs even before compilation.
set -euo pipefail

for attempt in 1 2 3; do
    log="download-attempt-${attempt}.log"
    set +e
    make source 2>&1 | tee "$log"
    results=("${PIPESTATUS[@]}")
    set -e
    [ "${results[1]}" -eq 0 ] || exit "${results[1]}"
    [ "${results[0]}" -ne 0 ] || exit 0

    # Re-running a partially applied patch only causes duplicate-patch errors.
    if grep -Eq '\.stamp_patched[^[:cntrl:]]*Error|hunks? FAILED|duplicate filename' "$log" \
        || ! grep -Eq '\.stamp_downloaded[^[:cntrl:]]*Error|Failed to download|failed to download' "$log"; then
        echo "::error::Source preparation failed outside a download; see $log. Not retrying."
        exit "${results[0]}"
    fi
    if [ "$attempt" -lt 3 ]; then
        echo "::warning::Source download attempt $attempt failed; retrying."
        sleep "${DOWNLOAD_RETRY_DELAY:-60}"
    fi
done

echo "::error::Source downloads failed after three attempts; see download-attempt-*.log."
exit 1
