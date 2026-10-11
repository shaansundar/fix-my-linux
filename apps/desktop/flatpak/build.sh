#!/bin/bash
# Builds the Flatpak bundle for one architecture (default: this machine's).
#
#   flatpak/build.sh            # x86_64 or aarch64, matching the host
#   flatpak/build.sh aarch64    # cross-arch needs qemu-user-static
#
# Needs flatpak-builder and the Flathub remote (for the runtime and the
# Electron base app). Output: release/fix-my-linux-<version>-<arch>.flatpak
set -euo pipefail
cd "$(dirname "$0")/.."

arch="${1:-$(uname -m)}"
case "$arch" in
  x86_64) builder_arch=x64 ;;
  aarch64) builder_arch=arm64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac
version="$(node -p 'require("./package.json").version')"

pnpm exec electron-vite build
pnpm exec electron-builder --linux dir "--${builder_arch}"

# rofiles-fuse only guards the build dir against stray writes, and FUSE is
# often missing on CI machines.
flatpak-builder --user --install-deps-from=flathub --force-clean --disable-rofiles-fuse --arch="$arch" \
  --repo=release/flatpak-repo release/flatpak-build flatpak/dev.fixmylinux.app.yml
flatpak build-bundle --arch="$arch" --runtime-repo=https://dl.flathub.org/repo/flathub.flatpakrepo \
  release/flatpak-repo "release/fix-my-linux-${version}-${arch}.flatpak" dev.fixmylinux.app
echo "release/fix-my-linux-${version}-${arch}.flatpak"
