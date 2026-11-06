$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "==> 安装前端依赖" -ForegroundColor Cyan
npm --prefix frontend install

Write-Host "==> 构建前端" -ForegroundColor Cyan
npm --prefix frontend run build

Write-Host "==> 构建 Go 二进制" -ForegroundColor Cyan
Push-Location backend
try {
    go build -o "$PSScriptRoot\llm-stress-lab.exe" .
} finally {
    Pop-Location
}

Write-Host "构建完成：llm-stress-lab.exe" -ForegroundColor Green
Write-Host "运行：./llm-stress-lab.exe -addr 127.0.0.1:8080"
