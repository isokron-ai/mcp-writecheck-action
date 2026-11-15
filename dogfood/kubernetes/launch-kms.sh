#!/usr/bin/env bash
# Start kubernetes-mcp-server (stdio) for mcp-writecheck and for hand checks.
#
# v0.1.x takes its runtime settings from a TOML file, not from flags or environment variables, and
# mcp-writecheck can only set environment variables. This shim writes the TOML from them, VERBATIM
# for read_only (so `read_only = yes` reaches the server's own TOML parser as an operator would type it).
#
#   MWSV_KMS_BIN            the server binary (required)
#   MWSV_K8S_API            the Kubernetes API URL the server uses (required; a loopback `kubectl proxy`
#                           that carries the server identity, or mcp-writecheck's gate in front of it)
#   MWSV_KMS_TOOLSETS       comma-separated toolsets (default core,config,helm,kubevirt)
#   MWSV_KMS_READ_ONLY      written as `read_only = <value>` when set
#   MWSV_KMS_ENABLED_TOOLS  comma-separated, written as enabled_tools = [...]
#   MWSV_KMS_DISABLED_TOOLS comma-separated, written as disabled_tools = [...]
set -euo pipefail
: "${MWSV_KMS_BIN:?set MWSV_KMS_BIN}" "${MWSV_K8S_API:?set MWSV_K8S_API}"
d="$(mktemp -d /tmp/mwsv-kms.XXXXXX)"
list() { local IFS=,; local out=""; for x in $1; do out="${out:+$out, }\"$x\""; done; printf '[%s]' "$out"; }
cat > "$d/kubeconfig" <<KC
apiVersion: v1
kind: Config
clusters:
- name: mwsv
  cluster: {server: "$MWSV_K8S_API"}
users:
- name: none
  user: {}
contexts:
- name: mwsv
  context: {cluster: mwsv, user: none, namespace: default}
current-context: mwsv
KC
{
  echo "toolsets = $(list "${MWSV_KMS_TOOLSETS:-core,config,helm,kubevirt}")"
  echo "kubeconfig = \"$d/kubeconfig\""
  if [ -n "${MWSV_KMS_READ_ONLY:-}" ]; then echo "read_only = $MWSV_KMS_READ_ONLY"; fi
  if [ -n "${MWSV_KMS_ENABLED_TOOLS:-}" ]; then echo "enabled_tools = $(list "$MWSV_KMS_ENABLED_TOOLS")"; fi
  if [ -n "${MWSV_KMS_DISABLED_TOOLS:-}" ]; then echo "disabled_tools = $(list "$MWSV_KMS_DISABLED_TOOLS")"; fi
} > "$d/config.toml"
export HOME="$d"
unset KUBECONFIG
exec "$MWSV_KMS_BIN" --config "$d/config.toml"
