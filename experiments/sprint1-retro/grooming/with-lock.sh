#!/bin/sh
# Rule 8 on this computer: run a heavy command under a shared lock, and remove the lock only if this script took it.
#   .scratch/grooming/with-lock.sh browser npx playwright test
#   .scratch/grooming/with-lock.sh check npm run check
# browser: one at a time (/tmp/postbox-browser.lock). check: two at a time (/tmp/postbox-check.lock.1 and .2).
# It waits up to 30 minutes for a lock, then gives up with exit 75. The command's own exit code is passed through.
kind=$1; shift
case $kind in
  browser) locks=/tmp/postbox-browser.lock ;;
  check) locks="/tmp/postbox-check.lock.1 /tmp/postbox-check.lock.2" ;;
  *) echo "with-lock.sh: the first argument is browser or check, not \"$kind\"." >&2; exit 64 ;;
esac
held=
i=0
while [ -z "$held" ]; do
  for l in $locks; do
    if mkdir "$l" 2>/dev/null; then held=$l; break; fi
  done
  [ -n "$held" ] && break
  i=$((i + 1))
  if [ "$i" -ge 180 ]; then echo "with-lock.sh: $kind lock still held after 30 minutes; not running." >&2; exit 75; fi
  sleep 10
done
trap 'rmdir "$held" 2>/dev/null' EXIT INT TERM HUP
echo "with-lock.sh: took $held" >&2
"$@"
