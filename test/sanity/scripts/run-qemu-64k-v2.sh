#!/bin/sh
set -e

ARGS="$*"

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
TEST_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

echo "Installing QEMU system emulation"
sudo apt-get update && sudo apt-get install -y qemu-system-arm

# Download Alpine minirootfs
ALPINE_VERSION="3.21"
ALPINE_ROOTFS="alpine-minirootfs-${ALPINE_VERSION}.0-aarch64.tar.gz"
ALPINE_URL="https://dl-cdn.alpinelinux.org/alpine/v${ALPINE_VERSION}/releases/aarch64/$ALPINE_ROOTFS"
DOWNLOAD_DIR=$(mktemp -d)

echo "Downloading Alpine minirootfs"
curl -fL "$ALPINE_URL" -o "$DOWNLOAD_DIR/$ALPINE_ROOTFS"

# Download 64k kernel
KERNEL_VERSION="6.8.0-90"
KERNEL_DEB="linux-image-unsigned-${KERNEL_VERSION}-generic-64k_${KERNEL_VERSION}.91_arm64.deb"
KERNEL_URL="https://ports.ubuntu.com/ubuntu-ports/pool/main/l/linux/$KERNEL_DEB"

echo "Downloading Ubuntu 64k kernel"
curl -fL "$KERNEL_URL" -o "$DOWNLOAD_DIR/kernel.deb"
cd "$DOWNLOAD_DIR" && ar x kernel.deb && rm kernel.deb
tar xf data.tar* && rm -f debian-binary control.tar* data.tar*
VMLINUZ="$DOWNLOAD_DIR/boot/vmlinuz-${KERNEL_VERSION}-generic-64k"

echo "Preparing rootfs"
ROOTFS_DIR=$(mktemp -d)
sudo tar -xzf "$DOWNLOAD_DIR/$ALPINE_ROOTFS" -C "$ROOTFS_DIR"

# Copy mount directory contents into /root
echo "Copying $TEST_DIR into rootfs"
sudo cp -r "$TEST_DIR"/* "$ROOTFS_DIR/root/"

# Install init script
echo "$ARGS" | sudo tee "$ROOTFS_DIR/test-args" > /dev/null
date -u '+%Y-%m-%d %H:%M:%S' | sudo tee "$ROOTFS_DIR/host-time" > /dev/null
sudo cp "$SCRIPT_DIR/qemu-init.sh" "$ROOTFS_DIR/init"
sudo chmod +x "$ROOTFS_DIR/init"

echo "Creating disk image"
DISK_IMG=$(mktemp)
dd if=/dev/zero of="$DISK_IMG" bs=1M count=512 status=none
sudo mkfs.ext4 -q -d "$ROOTFS_DIR" "$DISK_IMG"
sudo rm -rf "$ROOTFS_DIR"

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

rm -f "$DISK_IMG"
rm -rf "$DOWNLOAD_DIR"
