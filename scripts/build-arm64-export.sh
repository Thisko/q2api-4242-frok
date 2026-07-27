#!/bin/sh
# Build qwen-2api image for N1 (linux/arm64) on a stronger machine / VPS,
# then export a tar you can copy back to OpenWrt.
#
# Usage:
#   chmod +x scripts/build-arm64-export.sh
#   ./scripts/build-arm64-export.sh              # lightweight (default)
#   ./scripts/build-arm64-export.sh playwright   # with Playwright/Chromium
#
set -e

MODE="${1:-light}"
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PLATFORM="${PLATFORM:-linux/arm64}"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
mkdir -p "$OUT_DIR"

if [ "$MODE" = "playwright" ]; then
  DOCKERFILE="Dockerfile.playwright"
  IMAGE_TAG="${IMAGE_TAG:-qwen-2api:1.2.0-playwright-arm64}"
  TAR_NAME="qwen-2api-1.2.0-playwright-arm64.tar"
else
  DOCKERFILE="Dockerfile"
  IMAGE_TAG="${IMAGE_TAG:-qwen-2api:1.2.0-arm64}"
  TAR_NAME="qwen-2api-1.2.0-arm64.tar"
fi

echo "[1/3] Building $IMAGE_TAG for $PLATFORM using $DOCKERFILE ..."
if docker buildx version >/dev/null 2>&1; then
  docker buildx create --name qwen-builder --use >/dev/null 2>&1 || docker buildx use qwen-builder >/dev/null 2>&1 || true
  docker buildx build \
    --platform "$PLATFORM" \
    -f "$DOCKERFILE" \
    -t "$IMAGE_TAG" \
    --load \
    .
else
  echo "buildx not found, falling back to docker build (only works if this host is already arm64)"
  docker build -f "$DOCKERFILE" -t "$IMAGE_TAG" .
fi

echo "[2/3] Saving image to $OUT_DIR/$TAR_NAME ..."
docker save -o "$OUT_DIR/$TAR_NAME" "$IMAGE_TAG"

echo "[3/3] Done."
echo
echo "Copy to N1, then run:"
echo "  docker load -i $TAR_NAME"
echo "  # edit .env first"
echo "  docker compose up -d"
echo
ls -lh "$OUT_DIR/$TAR_NAME"
