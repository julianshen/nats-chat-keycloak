#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

for svc in "${GO_SERVICES[@]}"; do
  echo "Building $svc..."
  docker build -t "nats-chat/$svc:latest" -f "$PROJECT_ROOT/$svc/Dockerfile" "$PROJECT_ROOT"
done

# Room app services (nested under apps/)
echo "Building poll-service..."
docker build -t "nats-chat/poll-service:latest" -f "$PROJECT_ROOT/apps/poll/service/Dockerfile" "$PROJECT_ROOT"

echo "Building whiteboard-service..."
docker build -t "nats-chat/whiteboard-service:latest" -f "$PROJECT_ROOT/apps/whiteboard/service/Dockerfile" "$PROJECT_ROOT"

echo "Building kb-service..."
docker build -t "nats-chat/kb-service:latest" -f "$PROJECT_ROOT/apps/kb/service/Dockerfile" "$PROJECT_ROOT"

# Static file servers
echo "Building sticker-images..."
docker build -t "nats-chat/sticker-images:latest" -f "$PROJECT_ROOT/sticker-images/Dockerfile" "$PROJECT_ROOT"

echo "Building poll-app..."
docker build -t "nats-chat/poll-app:latest" -f "$PROJECT_ROOT/apps/poll/app/Dockerfile" "$PROJECT_ROOT"

echo "Building whiteboard-app..."
docker build -t "nats-chat/whiteboard-app:latest" -f "$PROJECT_ROOT/apps/whiteboard/app/Dockerfile" "$PROJECT_ROOT"

echo "Building kb-app..."
docker build -t "nats-chat/kb-app:latest" -f "$PROJECT_ROOT/apps/kb/app/Dockerfile" "$PROJECT_ROOT"

# Web frontend (production build)
echo "Building web..."
docker build -t "nats-chat/web:latest" -f "$PROJECT_ROOT/web/Dockerfile.prod" "$PROJECT_ROOT/web"

echo ""
echo "=== Applying Kubernetes manifests ==="
kubectl apply -k "$SCRIPT_DIR/overlays/local"

echo ""
echo "=== Waiting for pods ==="
kubectl -n nats-chat rollout status statefulset/postgres --timeout=120s
kubectl -n nats-chat rollout status statefulset/nats --timeout=120s

echo ""
echo "=== Running database init job ==="
# Delete previous job if it exists (jobs are immutable)
kubectl -n nats-chat delete job postgres-init --ignore-not-found
kubectl apply -k "$SCRIPT_DIR/overlays/local" --selector=app=postgres-init
kubectl -n nats-chat wait --for=condition=complete job/postgres-init --timeout=120s

echo ""
echo "=== Deployment complete ==="
echo "Web:      http://localhost:30000 (or via Ingress)"
echo "Keycloak: http://localhost:30080"
echo "Grafana:  http://localhost:30001"
echo ""
kubectl -n nats-chat get pods
