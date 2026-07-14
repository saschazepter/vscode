#!/usr/bin/env bash
set -e

# Get snapcraft version
snapcraft --version

# Configure apt to retry on transient network failures
# This applies to both the apt commands below and snapcraft's internal apt operations for stage-packages
sudo sh -c 'echo "Acquire::Retries \"5\";" > /etc/apt/apt.conf.d/80-retries'

# Point apt at the Azure Ubuntu mirror. The build agents cannot reach
<<<<<<< HEAD
# archive.ubuntu.com (DNS resolves it to a non-routable TEST-NET address, so
# connections time out), whereas the Azure mirror is reachable. This must run
# before any apt operation and before snapcraft, since snapcraft copies the
# host's /etc/apt configuration to download stage-packages. The snap job only
# runs in the x64 (amd64) container, so archive.ubuntu.com is the only mirror
# that needs redirecting.
=======
# archive.ubuntu.com/ports.ubuntu.com (DNS resolves them to a non-routable
# TEST-NET address, so connections time out), whereas the Azure mirror is
# reachable. This must run before any apt operation and before snapcraft, since
# snapcraft copies the host's /etc/apt configuration to download stage-packages.
>>>>>>> 9884e069708 (ci: switch archive.ubuntu.com to azure.archive.ubuntu.com for snap (#74))
for src in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
  [ -f "$src" ] || continue
  sudo sed -i \
    -e 's|http://archive.ubuntu.com|http://azure.archive.ubuntu.com|g' \
<<<<<<< HEAD
=======
    -e 's|http://ports.ubuntu.com|http://azure.ports.ubuntu.com|g' \
>>>>>>> 9884e069708 (ci: switch archive.ubuntu.com to azure.archive.ubuntu.com for snap (#74))
    "$src"
done

# Make sure we get latest packages
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y curl apt-transport-https ca-certificates

# Define variables
SNAP_ROOT="$(pwd)/.build/linux/snap/$VSCODE_ARCH"

# Create snap package
BUILD_VERSION="$(date +%s)"
SNAP_FILENAME="code-$VSCODE_QUALITY-$VSCODE_ARCH-$BUILD_VERSION.snap"
SNAP_PATH="$SNAP_ROOT/$SNAP_FILENAME"
case $VSCODE_ARCH in
  x64) SNAPCRAFT_TARGET_ARGS="" ;;
  *) SNAPCRAFT_TARGET_ARGS="--target-arch $VSCODE_ARCH" ;;
esac
(cd $SNAP_ROOT/code-* && sudo --preserve-env snapcraft snap $SNAPCRAFT_TARGET_ARGS --output "$SNAP_PATH")
