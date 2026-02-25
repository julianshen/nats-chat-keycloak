#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Force Docker client to use older API version (client v29 > daemon v24)
export DOCKER_API_VERSION=1.43

# K3s uses its own containerd; images must be imported after Docker build
KUBECTL="sudo k3s kubectl"
K3S_CTR="sudo k3s ctr"

import_image() {
  local tag="$1"
  echo "  Importing $tag into K3s..."
  docker save "$tag" | $K3S_CTR images import -
}

echo "=== Building Docker images ==="

# Go services (use root context for shared pkg/otelhelper)
GO_SERVICES=(
  auth-service
  persist-worker
  history-service
  fanout-service
  presence-service
  read-receipt-service
  room-service
  user-search-service
  translation-service
  sticker-service
  app-registry-service
)

ALL_IMAGES=()

for svc in "${GO_SERVICES[@]}"; do
  echo "Building $svc..."
  docker build -t "nats-chat/$svc:latest" -f "$PROJECT_ROOT/$svc/Dockerfile" "$PROJECT_ROOT"
  ALL_IMAGES+=("nats-chat/$svc:latest")
done

# Room app services (nested under apps/)
echo "Building poll-service..."
docker build -t "nats-chat/poll-service:latest" -f "$PROJECT_ROOT/apps/poll/service/Dockerfile" "$PROJECT_ROOT"
ALL_IMAGES+=("nats-chat/poll-service:latest")

echo "Building whiteboard-service..."
docker build -t "nats-chat/whiteboard-service:latest" -f "$PROJECT_ROOT/apps/whiteboard/service/Dockerfile" "$PROJECT_ROOT"
ALL_IMAGES+=("nats-chat/whiteboard-service:latest")

echo "Building kb-service..."
docker build -t "nats-chat/kb-service:latest" -f "$PROJECT_ROOT/apps/kb/service/Dockerfile" "$PROJECT_ROOT"
ALL_IMAGES+=("nats-chat/kb-service:latest")

# Static file servers
echo "Building sticker-images..."
docker build -t "nats-chat/sticker-images:latest" -f "$PROJECT_ROOT/sticker-images/Dockerfile" "$PROJECT_ROOT"
ALL_IMAGES+=("nats-chat/sticker-images:latest")

echo "Building poll-app..."
docker build -t "nats-chat/poll-app:latest" -f "$PROJECT_ROOT/apps/poll/app/Dockerfile" "$PROJECT_ROOT"
ALL_IMAGES+=("nats-chat/poll-app:latest")

echo "Building whiteboard-app..."
docker build -t "nats-chat/whiteboard-app:latest" -f "$PROJECT_ROOT/apps/whiteboard/app/Dockerfile" "$PROJECT_ROOT"
ALL_IMAGES+=("nats-chat/whiteboard-app:latest")

echo "Building kb-app..."
docker build -t "nats-chat/kb-app:latest" -f "$PROJECT_ROOT/apps/kb/app/Dockerfile" "$PROJECT_ROOT"
ALL_IMAGES+=("nats-chat/kb-app:latest")

# Web frontend (production build)
echo "Building web..."
docker build -t "nats-chat/web:latest" -f "$PROJECT_ROOT/web/Dockerfile.prod" "$PROJECT_ROOT/web"
ALL_IMAGES+=("nats-chat/web:latest")

echo ""
echo "=== Importing images into K3s containerd ==="
for img in "${ALL_IMAGES[@]}"; do
  import_image "$img"
done

echo ""
echo "=== Applying Kubernetes manifests ==="
$KUBECTL apply -k "$SCRIPT_DIR/overlays/local"

echo ""
echo "=== Waiting for pods ==="
$KUBECTL -n nats-chat rollout status statefulset/postgres --timeout=120s
$KUBECTL -n nats-chat rollout status statefulset/nats --timeout=120s

echo ""
echo "=== Running database init job ==="
# Delete previous job if it exists (jobs are immutable)
$KUBECTL -n nats-chat delete job postgres-init --ignore-not-found
$KUBECTL apply -k "$SCRIPT_DIR/overlays/local" --selector=app=postgres-init
$KUBECTL -n nats-chat wait --for=condition=complete job/postgres-init --timeout=120s

echo ""
echo "=== Deployment complete ==="
echo "Web:      https://chat.cowbay.wtf"
echo "Keycloak: https://chat.cowbay.wtf/auth"
echo "Grafana:  https://chat.cowbay.wtf/grafana"
echo ""
$KUBECTL -n nats-chat get pods
