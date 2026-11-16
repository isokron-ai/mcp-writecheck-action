#!/usr/bin/env bash
# Run as root before any target is installed (the workflow uses sudo). Keeps every container
# network away from the runner VM itself and from the cloud's metadata and agent addresses:
#   - DOCKER-USER (forwarded traffic, checked before Docker's own rules): drop 169.254.0.0/16
#     (instance metadata, link-local) and 168.63.129.16 (the Azure host agent / wire server);
#   - INPUT (traffic from a container to an address of the host): drop everything arriving on
#     docker0 or a br-* bridge of a user-defined network, so nothing on the runner (its own
#     services, the Docker API if it ever listened on TCP) is reachable from a container.
# The run-time networks are --internal already; this matters for the install step's egress network.
# Idempotent. Prints nothing about targets.
set -euo pipefail
command -v iptables >/dev/null || { echo "harness error: iptables not found"; exit 1; }
iptables -N DOCKER-USER 2>/dev/null || true
for dst in 169.254.0.0/16 168.63.129.16/32; do
  iptables -C DOCKER-USER -d "$dst" -j DROP 2>/dev/null || iptables -I DOCKER-USER -d "$dst" -j DROP
done
for ifc in docker0 'br-+'; do
  iptables -C INPUT -i "$ifc" -j DROP 2>/dev/null || iptables -I INPUT -i "$ifc" -j DROP
done
echo "container networks guarded"
