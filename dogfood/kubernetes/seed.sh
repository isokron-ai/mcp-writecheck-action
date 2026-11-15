#!/usr/bin/env bash
# Fixtures a run needs, created as the control identity (kind admin). Idempotent; run before every `run`.
#   mwsv-a/mwsv-guard            ConfigMap the tester's guard and canary read
#   mwsv-vm/mwsv-fix-vm          source VirtualMachine for vm_clone
#   mwsv-denied/mwsv-fix-denied  Helm release in a namespace where the server identity has no Secret access
#   mwsv-nosvcdel/mwsv-fix-pod   Pod and Service made by pods_run, where the server identity may not delete Services
# Needs MWSV_KUBECTL, ADMIN_KUBECONFIG, MWSV_KMS_BIN, MWSV_K8S_API, MWSV_K8S_CONTROL (set by up.sh) and the two kubectl proxies.
set -euo pipefail
k() { KUBECONFIG="$ADMIN_KUBECONFIG" "$MWSV_KUBECTL" "$@"; }
HERE="$(cd "$(dirname "$0")" && pwd)"
k apply -f - >/dev/null <<Y
apiVersion: v1
kind: ConfigMap
metadata: {name: mwsv-guard, namespace: mwsv-a}
data: {cluster: mwsv-kind}
---
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata: {name: mwsv-fix-vm, namespace: mwsv-vm}
spec:
  runStrategy: Halted
  template: {spec: {domain: {devices: {}}}}
Y
if ! k -n mwsv-denied get secret sh.helm.release.v1.mwsv-fix-denied.v1 >/dev/null 2>&1; then
  ( cd "$HERE" && MWSV_K8S_API="$MWSV_K8S_CONTROL" node "$HERE/mcp.mjs" call helm_install '{"chart":"charts/mwsv-cm","name":"mwsv-fix-denied","namespace":"mwsv-denied"}' >/dev/null )
fi
if ! k -n mwsv-nosvcdel get pod mwsv-fix-pod >/dev/null 2>&1; then
  k -n mwsv-nosvcdel delete svc mwsv-fix-pod --ignore-not-found >/dev/null
  ( cd "$HERE" && node "$HERE/mcp.mjs" call pods_run '{"image":"registry.k8s.io/pause:3.10@sha256:ee6521f290b2168b6e0935a181d4cff9be1ac3f505666ef0e3c98fae8199917a","name":"mwsv-fix-pod","namespace":"mwsv-nosvcdel","port":8080}' >/dev/null )
fi
k -n mwsv-a get cm mwsv-guard -o name; k -n mwsv-vm get vm mwsv-fix-vm -o name
k -n mwsv-denied get secret -o name; k -n mwsv-nosvcdel get pod,svc -o name
