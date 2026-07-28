#!/bin/sh
# 构建 qwen-2api + waf-harvester 两个 arm64 镜像并导出 tar，供 N1 使用。
#
# 用法：
#   chmod +x scripts/build-all.sh
#   ./scripts/build-all.sh
#
# 产物：
#   dist/qwen-2api-1.2.0-arm64.tar         （主服务，轻量，无 Chromium）
#   dist/waf-harvester-1.0.0-arm64.tar     （WAF 采集器，含 Chromium）
set -e

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PLATFORM="${PLATFORM:-linux/arm64}"
OUT_DIR="${OUT_DIR:-$ROOT/dist}"
mkdir -p "$OUT_DIR"

build_one() {
  DOCKERFILE="$1"
  IMAGE_TAG="$2"
  TAR_NAME="$3"

  echo "[build] $IMAGE_TAG ($DOCKERFILE) ..."
  if docker buildx version >/dev/null 2>&1; then
    docker buildx create --name qwen-builder --use >/dev/null 2>&1 || docker buildx use qwen-builder >/dev/null 2>&1 || true
    docker buildx build \
      --platform "$PLATFORM" \
      -f "$DOCKERFILE" \
      -t "$IMAGE_TAG" \
      --load \
      .
  else
    echo "buildx not found, falling back to docker build"
    docker build -f "$DOCKERFILE" -t "$IMAGE_TAG" .
  fi

  echo "[save] $OUT_DIR/$TAR_NAME"
  docker save -o "$OUT_DIR/$TAR_NAME" "$IMAGE_TAG"
  ls -lh "$OUT_DIR/$TAR_NAME"
  echo
}

build_one "Dockerfile"            "qwen-2api:1.2.0-arm64"      "qwen-2api-1.2.0-arm64.tar"
build_one "waf-harvester/Dockerfile" "waf-harvester:1.0.0-arm64" "waf-harvester-1.0.0-arm64.tar"

echo "=== 完成 ==="
echo "在 N1 上："
echo "  docker load -i qwen-2api-1.2.0-arm64.tar"
echo "  docker load -i waf-harvester-1.0.0-arm64.tar"
echo "  docker compose -f docker-compose.n1.yml up -d"