#!/bin/sh
# Flatpak launcher: Electron runs under zypak, which supplies Chromium's sandbox.
export TMPDIR="${XDG_RUNTIME_DIR}/app/${FLATPAK_ID}"
exec zypak-wrapper /app/fix-my-linux/fix-my-linux "$@"
