#!/bin/sh
set -e

ARGS="$*"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TEST_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

echo "Installing QEMU system emulation"
sudo tdnf install -y qemu-system-aarch64 binutils

# Download Ubuntu minimal cloud image (has networking, curl, etc. pre-installed)
UBUNTU_ROOTFS="ubuntu-24.04-minimal-cloudimg-arm64-root.tar.xz"
UBUNTU_URL="https://cloud-images.ubuntu.com/minimal/releases/noble/release/$UBUNTU_ROOTFS"
DOWNLOAD_DIR=$(mktemp -d)

echo "Downloading Ubuntu minimal cloud image"
curl -fL "$UBUNTU_URL" -o "$DOWNLOAD_DIR/$UBUNTU_ROOTFS"

# Download 64k kernel (Azure mirror for faster downloads in CI)
KERNEL_VERSION="6.8.0-90"
KERNEL_DEB="linux-image-unsigned-${KERNEL_VERSION}-generic-64k_${KERNEL_VERSION}.91_arm64.deb"
KERNEL_URL="https://azure.ports.ubuntu.com/ubuntu-ports/pool/main/l/linux/$KERNEL_DEB"

echo "Downloading Ubuntu 64k kernel"
curl -fL "$KERNEL_URL" -o "$DOWNLOAD_DIR/kernel.deb"
cd "$DOWNLOAD_DIR" && ar x kernel.deb && tar xf data.tar*
VMLINUZ="$DOWNLOAD_DIR/boot/vmlinuz-${KERNEL_VERSION}-generic-64k"

echo "Preparing rootfs"
ROOTFS_DIR=$(mktemp -d)
sudo tar -xJf "$DOWNLOAD_DIR/$UBUNTU_ROOTFS" -C "$ROOTFS_DIR"

echo "Copying $TEST_DIR into rootfs"
sudo cp -r "$TEST_DIR"/* "$ROOTFS_DIR/root/"

echo "Pre-installing packages in rootfs (chroot on ARM64 host)"
sudo rm -f "$ROOTFS_DIR/etc/resolv.conf"
echo "nameserver 8.8.8.8" | sudo tee "$ROOTFS_DIR/etc/resolv.conf" > /dev/null
sudo mount --bind /dev "$ROOTFS_DIR/dev"
sudo mount --bind /dev/pts "$ROOTFS_DIR/dev/pts"
sudo mount -t proc proc "$ROOTFS_DIR/proc"
sudo mount -t sysfs sys "$ROOTFS_DIR/sys"
sudo chroot "$ROOTFS_DIR" /bin/sh -c "
	sed -i 's|http://ports.ubuntu.com|http://azure.ports.ubuntu.com|g' /etc/apt/sources.list.d/ubuntu.sources
	apt-get update
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
	apt-get install -y nodejs xvfb dbus dbus-x11 libasound2t64 libgtk-3-0t64 libcurl4t64 libgbm1 libnss3 xdg-utils
"
sudo umount "$ROOTFS_DIR/sys"
sudo umount "$ROOTFS_DIR/proc"
sudo umount "$ROOTFS_DIR/dev/pts"
sudo umount "$ROOTFS_DIR/dev"

echo "Installing init script"
echo "$ARGS" | sudo tee "$ROOTFS_DIR/test-args" > /dev/null
date -u '+%Y-%m-%d %H:%M:%S' | sudo tee "$ROOTFS_DIR/host-time" > /dev/null
sudo cp "$SCRIPT_DIR/qemu-init.sh" "$ROOTFS_DIR/init"
sudo chmod +x "$ROOTFS_DIR/init"

echo "Creating disk image"
DISK_IMG=$(mktemp)
dd if=/dev/zero of="$DISK_IMG" bs=1M count=2048 status=none
sudo mkfs.ext4 -q -d "$ROOTFS_DIR" "$DISK_IMG"

echo "Starting QEMU VM with 64K page size kernel"
timeout 1800 qemu-system-aarch64 \
	-M virt \
	-cpu max,pauth-impdef=on \
	-accel tcg,thread=multi \
	-m 4096 \
	-smp 2 \
	-kernel "$VMLINUZ" \
	-append "console=ttyAMA0 root=/dev/vda rw init=/init net.ifnames=0" \
	-drive file="$DISK_IMG",format=raw,if=virtio \
	-netdev user,id=net0 \
	-device virtio-net-pci,netdev=net0 \
	-nographic \
	-no-reboot

echo "Extracting test results from disk image"
MOUNT_DIR=$(mktemp -d)
sudo mount -o loop "$DISK_IMG" "$MOUNT_DIR"
sudo cp "$MOUNT_DIR/root/results.xml" "$TEST_DIR/results.xml" 2>/dev/null || true
sudo chown "$(id -u):$(id -g)" "$TEST_DIR/results.xml" 2>/dev/null || true

EXIT_CODE=$(sudo cat "$MOUNT_DIR/exit-code" 2>/dev/null || echo 1)
exit $EXIT_CODE
