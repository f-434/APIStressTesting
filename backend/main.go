package main

import (
	"embed"
	"flag"
	"io/fs"
	"log"
	"net/http"

	"apistress/internal/server"
)

//go:embed all:web
var webFiles embed.FS

func main() {
	addr := flag.String("addr", "127.0.0.1:8080", "HTTP 监听地址")
	flag.Parse()

	web, err := fs.Sub(webFiles, "web")
	if err != nil {
		log.Fatalf("读取内嵌前端资源失败: %v", err)
	}

	handler := server.New(web)
	log.Printf("LLM Stress Lab 已启动: http://%s", *addr)
	if err := http.ListenAndServe(*addr, handler); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}
