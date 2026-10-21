#!/bin/sh
# Native execution selects its installed version through AIDLC_BIN_DIR. Keep this
# entry point on the login shell's default PATH; workflow files stay on EFS.
case "${AIDLC_BIN_DIR:-}" in
  /*) ;;
  *) echo "Native AI-DLC installation is not configured." >&2; exit 127 ;;
esac
target=$(/usr/bin/readlink -f "$AIDLC_BIN_DIR/aidlc") || exit 127
if [ ! -f "$target" ] || [ ! -x "$target" ] || [ "$target" -ef "$0" ]; then
  echo "Native AI-DLC executable is unavailable." >&2
  exit 127
fi
exec "$target" "$@"
