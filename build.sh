#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 安装前端依赖"
npm --prefix frontend install

echo "==> 构建前端"
npm --prefix frontend run build

echo "==> 构建 Go 二进制"
(
  cd backend
  go build -o ../llm-stress-lab .
)

echo "构建完成：llm-stress-lab"
echo "运行：./llm-stress-lab -addr 127.0.0.1:8080"
