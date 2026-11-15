#!/usr/bin/env bash
# Creates the disposable kind cluster for one dogfood job and everything the manifest expects in it:
# RBAC for the server identity (ServiceAccount kms), the fixed namespaces and their RoleBindings, the
# two loopback kubectl proxies (4902: the server identity; 4903: the cluster admin, for the control arm
# and the fixtures), and objects the tester does not create (bystanders).
#   dogfood/kubernetes/up.sh <experiment checkout>
# Needs kind and docker on PATH, RUNNER_TEMP and GITHUB_ENV. The service-account token is written to a
# file that only kubectl reads; it is masked and never printed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EXP="$(cd "${1:?experiment checkout}" && pwd)"
S="${RUNNER_TEMP:?}/k8s"
mkdir -p "$S"; chmod 700 "$S"

kind create cluster --config "$HERE/cluster/kind-config.yaml" --kubeconfig "$S/admin.kubeconfig" --wait 300s
chmod 600 "$S/admin.kubeconfig"
# kubectl of the node's own version (1.37.0), so there is no client/server skew.
docker cp mwsdf-k8s-control-plane:/usr/bin/kubectl "$S/kubectl"
export MWSV_KUBECTL="$S/kubectl" ADMIN_KUBECONFIG="$S/admin.kubeconfig"
{ echo "MWSV_KUBECTL=$MWSV_KUBECTL"; echo "ADMIN_KUBECONFIG=$ADMIN_KUBECONFIG"; } >> "$GITHUB_ENV"
k() { KUBECONFIG="$ADMIN_KUBECONFIG" "$MWSV_KUBECTL" "$@"; }

k apply -f "$EXP/harness/cluster/server-rbac.yaml" -f "$EXP/harness/cluster/addons.yaml"
k apply -f "$HERE/cluster/probe-rbac.yaml" -f "$HERE/cluster/mwsv-rbac.yaml" -f "$HERE/cluster/kubevirt-crds-standin.yaml"
k wait --for=condition=Established --timeout=60s crd -l mwsv/addon=kubevirt-crds-standin
for ns in mwsv-a mwsv-denied mwsv-nosvcdel mwsv-vm; do k create ns "$ns"; done
bind() { ns=$1; shift; for r in "$@"; do k -n "$ns" create rolebinding "mwsv-$r" --clusterrole="$r" --serviceaccount=mcp-audit-system:kms; done; }
bind mwsv-a kms-probe-write kms-probe-write-addons kms-helm-releases
bind default kms-probe-write kms-helm-releases          # MWS-TGT-1: the server identity writes in the default scope too
bind mwsv-denied kms-probe-write                        # no Secret access: helm_uninstall's lookup is refused
bind mwsv-nosvcdel kms-probe-write-nosvcdelete          # may not delete Services: pods_delete's declared failure
bind mwsv-vm kms-probe-write kms-probe-write-addons

# The server identity's kubeconfig, for its proxy only.
umask 077
k create token kms -n mcp-audit-system --duration 6h > "$S/kms.token"
echo "::add-mask::$(cat "$S/kms.token")"
CA=$(k config view --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
cat > "$S/kms.kubeconfig" <<KC
apiVersion: v1
kind: Config
clusters: [{name: c, cluster: {server: "https://127.0.0.1:4901", certificate-authority-data: "$CA"}}]
users: [{name: kms, user: {tokenFile: "$S/kms.token"}}]
contexts: [{name: c, context: {cluster: c, user: kms, namespace: default}}]
current-context: c
KC
umask 022
KUBECONFIG="$S/kms.kubeconfig" nohup "$MWSV_KUBECTL" proxy --port=4902 --address=127.0.0.1 > "$S/proxy-kms.log" 2>&1 &
KUBECONFIG="$ADMIN_KUBECONFIG" nohup "$MWSV_KUBECTL" proxy --port=4903 --address=127.0.0.1 > "$S/proxy-admin.log" 2>&1 &
for p in 4902 4903; do
  for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$p/version" >/dev/null && break; sleep 1; done
  curl -sf "http://127.0.0.1:$p/version" >/dev/null || { echo "::error::kubectl proxy on $p did not answer"; exit 1; }
done

# Objects the tester does not create: the bystander inventory must find every one unchanged.
k create ns mwsv-bystander
for ns in default mwsv-a mwsv-bystander; do k -n "$ns" create configmap mwsv-bystander-cm --from-literal=owner=someone-else --from-literal=note="not the tester's"; done
for ns in default mwsv-bystander; do k -n "$ns" create service clusterip mwsv-bystander-svc --tcp=8080:8080; done
echo "cluster ready"
