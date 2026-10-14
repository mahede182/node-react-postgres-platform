#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-nrp}"

command -v kind >/dev/null || { echo "kind is required"; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl is required"; exit 1; }
command -v docker >/dev/null || { echo "docker is required"; exit 1; }

if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  kind create cluster --name "$CLUSTER_NAME"
fi

echo "Building images..."
docker build -f "$ROOT/Dockerfile.backend" -t node-react-postgres-platform-backend:local "$ROOT"
docker build -f "$ROOT/Dockerfile.frontend" -t node-react-postgres-platform-frontend:local "$ROOT"
kind load docker-image node-react-postgres-platform-backend:local --name "$CLUSTER_NAME"
kind load docker-image node-react-postgres-platform-frontend:local --name "$CLUSTER_NAME"

echo "Installing ingress-nginx..."
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.2/deploy/static/provider/kind/deploy.yaml
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=180s

echo "Applying app manifests..."
kubectl apply -f "$ROOT/k8s/namespace-dev.yaml"

tmpdir="$(mktemp -d)"
cp "$ROOT"/k8s/*.yaml "$tmpdir/"
sed -i.bak 's#ghcr.io/example/node-react-postgres-platform-backend:.*#node-react-postgres-platform-backend:local#' \
  "$tmpdir/backend-deployment.yaml" "$tmpdir/bullmq-worker-deployment.yaml"
sed -i.bak 's#ghcr.io/example/node-react-postgres-platform-frontend:.*#node-react-postgres-platform-frontend:local#' \
  "$tmpdir/frontend-deployment.yaml"

kubectl apply -n dev -f "$tmpdir"
kubectl apply -n dev -f "$ROOT/observability/"

grep -q "node-react.local" /etc/hosts || \
  echo "127.0.0.1 node-react.local" | sudo tee -a /etc/hosts

echo "Waiting for rollouts..."
kubectl -n dev rollout status deployment/backend --timeout=180s || true
kubectl -n dev rollout status deployment/frontend --timeout=180s || true
echo "Done. Open http://node-react.local  (Grafana NodePort :30300)"
