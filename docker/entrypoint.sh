#!/bin/sh
set -eu
umask 077
mkdir -p /data/files
# Only runtime directories on the dedicated named volumes are owned by the app.
chown -R node:node /data
chmod 700 /data /data/files
cups_pid=''
avahi_pid=''
app_pid=''
stop() {
  trap - TERM INT
  if [ -n "$app_pid" ]; then kill -TERM "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true; fi
  if [ -n "$cups_pid" ]; then kill -TERM "$cups_pid" 2>/dev/null || true; fi
  if [ -n "$avahi_pid" ]; then kill -TERM "$avahi_pid" 2>/dev/null || true; fi
}
trap stop TERM INT EXIT
if [ "${HARDWARE_SERVICES:-true}" = 'true' ]; then
  mkdir -p /run/dbus /run/cups /run/avahi-daemon
  chmod 755 /run/dbus /run/cups /run/avahi-daemon
  rm -f /run/dbus/pid /run/avahi-daemon/pid
  dbus-daemon --system --fork --nopidfile
  avahi-daemon --no-chroot &
  avahi_pid=$!
  /usr/sbin/cupsd -f &
  cups_pid=$!
  attempt=0
  until lpstat -h "${CUPS_SERVER:-localhost:631}" -r >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 20 ]; then echo 'CUPS failed to start. Check for a host port 631 conflict.' >&2; exit 1; fi
    sleep 1
  done
fi
# Hardware daemons need initial root privileges; the web server always runs as node.
setpriv --reuid=node --regid=node --init-groups node apps/server/dist/index.js &
app_pid=$!
set +e
wait "$app_pid"
status=$?
app_pid=''
exit "$status"
