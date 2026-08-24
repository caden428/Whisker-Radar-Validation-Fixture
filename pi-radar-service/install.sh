#!/bin/sh
# Installs the already-reviewed service files on a Debian-based fixture Pi.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo ./install.sh" >&2
  exit 1
fi

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -d -o pi -g pi /opt/radar-settings
install -m 0644 -o pi -g pi "$SOURCE_DIR/radar_protocol.py" /opt/radar-settings/radar_protocol.py
install -m 0644 -o pi -g pi "$SOURCE_DIR/ld021_protocol.py" /opt/radar-settings/ld021_protocol.py
install -m 0755 -o pi -g pi "$SOURCE_DIR/radar_service.py" /opt/radar-settings/radar_service.py
install -m 0644 -o pi -g pi "$SOURCE_DIR/test_radar_service.py" /opt/radar-settings/test_radar_service.py
install -m 0644 "$SOURCE_DIR/radar-settings.service" /etc/systemd/system/radar-settings.service
if [ ! -f /etc/default/radar-settings ]; then
  install -m 0640 -o root -g pi "$SOURCE_DIR/radar-settings.default" /etc/default/radar-settings
fi

apt-get update
apt-get install -y pigpio python3-pigpio
systemctl enable --now pigpiod.service
systemctl daemon-reload
systemctl enable radar-settings.service
systemctl restart radar-settings.service
systemctl --no-pager --full status radar-settings.service
