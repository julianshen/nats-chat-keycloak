#!/usr/bin/env bash
set -euo pipefail

export DOCKER_API_VERSION=1.43

KUBECTL="sudo k3s kubectl"
K3S_CTR="sudo k3s ctr"

echo "=== Importing images into K3s containerd ==="
docker images --format '{{.Repository}}:{{.Tag}}' | { grep '^nats-chat/' || true; } | while read -r img; do
  echo "  Importing $img..."
  docker save "$img" | $K3S_CTR images import -
done

echo ""
echo "=== Applying Kubernetes manifests ==="
$KUBECTL apply -k "$(dirname "$0")/overlays/local"

echo ""
echo "=== Waiting for StatefulSets ==="
$KUBECTL -n nats-chat rollout status statefulset/postgres --timeout=120s
$KUBECTL -n nats-chat rollout status statefulset/nats --timeout=120s

echo ""
echo "=== Running database init job ==="
$KUBECTL -n nats-chat delete job postgres-init --ignore-not-found
$KUBECTL apply -k "$(dirname "$0")/overlays/local" --selector=app=postgres-init
$KUBECTL -n nats-chat wait --for=condition=complete job/postgres-init --timeout=120s

echo ""
echo "=== Restarting deployments with updated images ==="
$KUBECTL -n nats-chat rollout restart deployment

echo ""
echo "=== Waiting for rollouts ==="
$KUBECTL -n nats-chat get deploy -o name | while read -r dep; do
  $KUBECTL -n nats-chat rollout status "$dep" --timeout=120s
done

echo ""
echo "=== Deployment complete ==="
echo "Web:      http://localhost:30000"
echo "Keycloak: http://localhost:30000/auth"
echo "Grafana:  http://localhost:30000/grafana"
echo ""
$KUBECTL -n nats-chat get pods
