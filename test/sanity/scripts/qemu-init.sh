#!/bin/sh
set -e

echo "Mounting kernel filesystems"
mount -t proc proc /proc
mount -t sysfs sys /sys

echo "Mounting PTY and shared memory"
mkdir -p /dev/pts
mount -t devpts devpts /dev/pts
mkdir -p /dev/shm
mount -t tmpfs tmpfs /dev/shm

echo "Mounting temporary directories"
mount -t tmpfs tmpfs /tmp
chmod 1777 /tmp
mount -t tmpfs tmpfs /var/tmp

echo "Mounting runtime directories"
mount -t tmpfs tmpfs /run
mkdir -p /run/dbus
mkdir -p /run/user/0
chmod 700 /run/user/0

echo "Setting up machine-id for D-Bus"
cat /proc/sys/kernel/random/uuid | tr -d '-' > /etc/machine-id

echo "Setting system clock"
date -s "$(cat /host-time)"

echo "Setting up networking"
ip link set lo up
ip link set eth0 up
ip addr add 10.0.2.15/24 dev eth0
ip route add default via 10.0.2.2
rm -f /etc/resolv.conf
echo "nameserver 10.0.2.3" > /etc/resolv.conf

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export XDG_RUNTIME_DIR=/run/user/0

echo "Configuring Azure package mirror"
sed -i 's|http://ports.ubuntu.com|http://azure.ports.ubuntu.com|g' /etc/apt/sources.list.d/ubuntu.sources
apt-get update

echo "Installing Node.js 22"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

echo "Installing X11 and D-Bus"
apt-get install -y --no-install-recommends xvfb dbus dbus-x11

echo "Installing VS Code dependencies"
apt-get install -y --no-install-recommends \
	libasound2t64 libgtk-3-0t64 libcurl4t64 libgbm1 libnss3 xdg-utils

echo "Starting entrypoint"
sh /root/containers/entrypoint.sh $(cat /test-args)
echo $? > /exit-code
sync

echo "Powering off"
echo o > /proc/sysrq-trigger
