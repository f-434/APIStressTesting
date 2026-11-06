package server

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"apistress/internal/bench"
)

type Server struct {
	store  *bench.Store
	runner *bench.Runner
	web    fs.FS
}

func New(web fs.FS) http.Handler {
	store := bench.NewStore()
	s := &Server{
		store:  store,
		runner: bench.NewRunner(store),
		web:    web,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/models", s.handleModels)
	mux.HandleFunc("POST /api/tests", s.handleStartTest)
	mux.HandleFunc("GET /api/tests", s.handleListTests)
	mux.HandleFunc("GET /api/tests/{id}", s.handleGetTest)
	mux.HandleFunc("POST /api/tests/{id}/stop", s.handleStopTest)
	mux.HandleFunc("GET /api/tests/{id}/events", s.handleEvents)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "time": time.Now()})
	})
	mux.HandleFunc("GET /", s.handleStatic)

	return withCORS(mux)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 4<<20)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		writeErr(w, http.StatusBadRequest, "请求体格式错误："+err.Error())
		return false
	}
	return true
}

func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BaseURL  string `json:"baseUrl"`
		APIKey   string `json:"apiKey"`
		Protocol string `json:"protocol"`
	}
	if !decodeJSON(w, r, &req) {
		return
	}
	if req.Protocol == "" {
		req.Protocol = bench.ProtoAuto
	}
	ctx := r.Context()
	models, endpoint, warnings, err := bench.FetchModels(ctx, req.BaseURL, req.APIKey, req.Protocol)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error":    err.Error(),
			"warnings": warnings,
			"endpoint": endpoint,
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"models":   models,
		"endpoint": endpoint,
		"warnings": warnings,
		"count":    len(models),
	})
}

func (s *Server) handleStartTest(w http.ResponseWriter, r *http.Request) {
	var cfg bench.TestConfig
	if !decodeJSON(w, r, &cfg) {
		return
	}
	test, err := s.runner.Start(cfg)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":     test.ID,
		"status": bench.StatusRunning,
	})
}

func (s *Server) handleListTests(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"tests": s.store.List()})
}

func (s *Server) handleGetTest(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	test, ok := s.store.Get(id)
	if !ok {
		writeErr(w, http.StatusNotFound, "测试不存在或已被清理")
		return
	}
	status := test.CurrentStatus()
	if status == bench.StatusRunning {
		live := test.Live()
		writeJSON(w, http.StatusOK, map[string]any{"status": status, "live": live})
		return
	}
	report := test.Report()
	if report == nil {
		live := test.Live()
		writeJSON(w, http.StatusOK, map[string]any{"status": status, "live": live})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "report": report})
}

func (s *Server) handleStopTest(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	test, ok := s.store.Get(id)
	if !ok {
		writeErr(w, http.StatusNotFound, "测试不存在或已被清理")
		return
	}
	stopped := test.Stop()
	writeJSON(w, http.StatusOK, map[string]any{"ok": stopped, "id": id})
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	test, ok := s.store.Get(id)
	if !ok {
		writeErr(w, http.StatusNotFound, "测试不存在或已被清理")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "当前服务器不支持 SSE")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch, live, finished := test.Subscribe()
	defer test.Unsubscribe(ch)

	send := func(event string, data any) bool {
		payload, err := json.Marshal(data)
		if err != nil {
			return true
		}
		if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, payload); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	if !send("snapshot", live) {
		return
	}
	if finished {
		send("done", map[string]any{"testId": test.ID, "status": live.Status})
		return
	}

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	ctx := r.Context()
	for {
		select {
		case ev := <-ch:
			if !send(ev.Type, ev.Data) {
				return
			}
			if ev.Type == "done" {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-ctx.Done():
			return
		}
	}
}

func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if path == "" {
		path = "index.html"
	}
	if file, err := s.web.Open(path); err == nil {
		if stat, statErr := file.Stat(); statErr == nil && !stat.IsDir() {
			file.Close()
			if strings.HasPrefix(path, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			http.FileServer(http.FS(s.web)).ServeHTTP(w, r)
			return
		}
		file.Close()
	}
	data, err := fs.ReadFile(s.web, "index.html")
	if err != nil {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprint(w, "前端资源尚未构建。请先执行 npm run build（或使用 npm run dev 启动开发服务器）。")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
