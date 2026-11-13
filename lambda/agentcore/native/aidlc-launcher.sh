#!/bin/sh
# Native execution selects its installed version through AIDLC_BIN_DIR. Keep this
# entry point on the login shell's default PATH; workflow files stay on EFS.
if [ -n "${NATIVE_WORKFLOW_CONTEXT:-}" ]; then
  # Local CLI lifecycle hooks remain presentation/workspace helpers. They
  # cannot submit member, reviewer or terminal authority to the service.
  case "$1 $2" in
    "engine hook") ;;
    "--version "|"version ") ;;
    # Installation helpers keep their arguments; they hold no workflow authority.
    "use "*|"project "*) ;;
    *) exec /usr/local/bin/node /opt/agentcore/native/workflow-cli.mjs "$@" ;;
  esac
fi
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
