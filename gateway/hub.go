package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// mime.TypeByExtension falls back to the OS mime registry (/etc/mime.types),
// which is missing on minimal Linux images — that made .css/.js serve as
// text/plain and get MIME-blocked by strict browser checks.
var staticContentTypes = map[string]string{
	".css":  "text/css; charset=utf-8",
	".js":   "application/javascript; charset=utf-8",
	".mjs":  "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".svg":  "image/svg+xml",
}

// Hub-mode API: one WebUI, many edge machines.

// Paths that the hub answers itself (not proxied to a single machine).
func (g *gateway) isHubLocalAPI(path string) bool {
	switch {
	case path == "/api/hub", path == "/api/machines",
		path == "/api/auth/status", path == "/api/auth/login", path == "/api/auth/register",
		path == "/api/sessions", path == "/api/projects", path == "/api/activity",
		path == "/api/sessions/meta":
		return true
	default:
		return false
	}
}

func (g *gateway) handleHubInfo(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"hub":     true,
		"version": version,
		"mode":    "hub",
		"machines": g.listMachines(),
	})
}

// fanInGET calls path on every online machine in parallel and returns []raw JSON values + errors.
func (g *gateway) fanInGET(path string) (results []struct {
	MachineID string
	Status    int
	Body      []byte
	Err       string
}) {
	ms := g.listMachines()
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, m := range ms {
		id, _ := m["id"].(string)
		if id == "" {
			continue
		}
		wg.Add(1)
		go func(machineID string) {
			defer wg.Done()
			res, err := g.forwardHTTP(machineID, http.MethodGet, path, g.edgeHeaders(), "")
			entry := struct {
				MachineID string
				Status    int
				Body      []byte
				Err       string
			}{MachineID: machineID}
			if err != nil {
				entry.Err = err.Error()
				entry.Status = 502
			} else {
				entry.Status = res.Status
				entry.Body = []byte(res.Body)
			}
			mu.Lock()
			results = append(results, entry)
			mu.Unlock()
		}(id)
	}
	wg.Wait()
	return results
}

func (g *gateway) edgeHeaders() map[string]string {
	// Edge trusts X-Hub-Token == MACHINE_TOKEN (never exposed to browser).
	return map[string]string{
		"X-Hub-Token":  g.token,
		"X-Hub-User":   g.hubUser(),
		"Content-Type": "application/json",
		"Host":         "localhost",
	}
}

func (g *gateway) handleAggregateSessions(w http.ResponseWriter, r *http.Request) {
	if _, ok := g.requireHubAuth(w, r); !ok {
		return
	}
	q := r.URL.RawQuery
	path := "/api/sessions"
	if q != "" {
		path += "?" + q
	}

	// Fast path: only one machine (X-Machine-Id or ?machine=) — used when UI already selected an edge
	only := r.Header.Get("X-Machine-Id")
	if only == "" {
		only = r.URL.Query().Get("machine")
	}
	if only != "" {
		// strip machine from query when forwarding
		fwd := "/api/sessions"
		vals := r.URL.Query()
		vals.Del("machine")
		if enc := vals.Encode(); enc != "" {
			fwd += "?" + enc
		}
		res, err := g.forwardHTTP(only, http.MethodGet, fwd, g.edgeHeaders(), "")
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadGateway)
			return
		}
		var list []map[string]any
		_ = json.Unmarshal([]byte(res.Body), &list)
		for i := range list {
			list[i]["machineId"] = only
			if sid, _ := list[i]["sessionId"].(string); sid != "" {
				list[i]["id"] = only + ":" + sid
			}
		}
		if list == nil {
			list = []map[string]any{}
		}
		writeJSON(w, list)
		return
	}

	var merged []map[string]any
	for _, item := range g.fanInGET(path) {
		if item.Err != "" || item.Status >= 400 {
			log.Printf("[hub] sessions %s: %s status=%d", item.MachineID, item.Err, item.Status)
			continue
		}
		var list []map[string]any
		if err := json.Unmarshal(item.Body, &list); err != nil {
			continue
		}
		for _, s := range list {
			s["machineId"] = item.MachineID
			// stable unique key for UI if needed
			if sid, _ := s["sessionId"].(string); sid != "" {
				s["id"] = item.MachineID + ":" + sid
			}
			merged = append(merged, s)
		}
	}
	if merged == nil {
		merged = []map[string]any{}
	}
	writeJSON(w, merged)
}

func (g *gateway) handleAggregateProjects(w http.ResponseWriter, r *http.Request) {
	if _, ok := g.requireHubAuth(w, r); !ok {
		return
	}
	// Build from aggregated sessions client-side shape; re-group by cwd+machine
	q := r.URL.RawQuery
	path := "/api/sessions"
	if q != "" {
		path += "?" + q
	}
	// simpler: proxy projects per machine and tag
	path = "/api/projects"
	if q != "" {
		path = "/api/projects?" + q
	}
	var merged []map[string]any
	for _, item := range g.fanInGET(path) {
		if item.Err != "" || item.Status >= 400 {
			continue
		}
		var list []map[string]any
		if err := json.Unmarshal(item.Body, &list); err != nil {
			continue
		}
		for _, p := range list {
			p["machineId"] = item.MachineID
			merged = append(merged, p)
		}
	}
	if merged == nil {
		merged = []map[string]any{}
	}
	writeJSON(w, merged)
}

func (g *gateway) handleAggregateActivity(w http.ResponseWriter, r *http.Request) {
	if _, ok := g.requireHubAuth(w, r); !ok {
		return
	}
	path := "/api/activity"
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}
	var allResults []map[string]any
	for _, item := range g.fanInGET(path) {
		if item.Err != "" || item.Status >= 400 {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(item.Body, &payload); err != nil {
			// maybe array
			var arr []map[string]any
			if err2 := json.Unmarshal(item.Body, &arr); err2 == nil {
				for _, s := range arr {
					s["machineId"] = item.MachineID
					allResults = append(allResults, s)
				}
			}
			continue
		}
		if results, ok := payload["results"].([]any); ok {
			for _, raw := range results {
				if m, ok := raw.(map[string]any); ok {
					m["machineId"] = item.MachineID
					allResults = append(allResults, m)
				}
			}
		}
	}
	if allResults == nil {
		allResults = []map[string]any{}
	}
	writeJSON(w, map[string]any{"results": allResults, "q": r.URL.Query().Get("q")})
}

func (g *gateway) handleAggregateSessionMeta(w http.ResponseWriter, r *http.Request) {
	if _, ok := g.requireHubAuth(w, r); !ok {
		return
	}
	// Merge meta maps keyed by machineId:agent:sessionId
	out := map[string]any{}
	for _, item := range g.fanInGET("/api/sessions/meta") {
		if item.Err != "" || item.Status >= 400 {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(item.Body, &m); err != nil {
			continue
		}
		for k, v := range m {
			out[item.MachineID+":"+k] = v
		}
	}
	writeJSON(w, out)
}

// Proxy a browser API call to one edge machine.
func (g *gateway) handleProxiedAPI(w http.ResponseWriter, r *http.Request) {
	if _, ok := g.requireHubAuth(w, r); !ok {
		return
	}
	machineID := r.Header.Get("X-Machine-Id")
	if machineID == "" {
		machineID = r.URL.Query().Get("machine")
	}
	if machineID == "" {
		http.Error(w, `{"error":"X-Machine-Id or ?machine= required"}`, http.StatusBadRequest)
		return
	}
	if g.getMachine(machineID) == nil {
		http.Error(w, fmt.Sprintf(`{"error":"Machine %q not connected"}`, machineID), http.StatusServiceUnavailable)
		return
	}

	// Strip machine query param when forwarding
	q := r.URL.Query()
	q.Del("machine")
	fwdPath := r.URL.Path
	if enc := q.Encode(); enc != "" {
		fwdPath += "?" + enc
	}

	var bodyStr string
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		b, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if len(b) > maxBodyBytes {
			http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
			return
		}
		bodyStr = string(b)
	}

	headers := g.edgeHeaders()
	for k, vals := range r.Header {
		if len(vals) == 0 {
			continue
		}
		lk := strings.ToLower(k)
		if lk == "host" || lk == "authorization" || lk == "connection" ||
			lk == "content-length" || lk == "x-machine-id" || lk == "x-hub-token" {
			continue
		}
		headers[k] = vals[0]
	}

	res, err := g.forwardHTTP(machineID, r.Method, fwdPath, headers, bodyStr)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadGateway)
		return
	}
	for k, v := range res.Headers {
		lk := strings.ToLower(k)
		if lk == "transfer-encoding" || lk == "connection" || lk == "keep-alive" {
			continue
		}
		w.Header().Set(k, v)
	}
	status := res.Status
	if status == 0 {
		status = 200
	}
	w.WriteHeader(status)
	_, _ = w.Write([]byte(res.Body))
}

func (g *gateway) publicDir() string {
	if d := os.Getenv("PUBLIC_DIR"); d != "" {
		return d
	}
	// default: ../public relative to cwd, or next to binary
	candidates := []string{
		"public",
		"../public",
		filepath.Join(filepath.Dir(os.Args[0]), "public"),
		filepath.Join(filepath.Dir(os.Args[0]), "../public"),
	}
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			abs, _ := filepath.Abs(c)
			return abs
		}
	}
	return ""
}

func (g *gateway) handleStatic(w http.ResponseWriter, r *http.Request) {
	dir := g.publicDir()
	if dir == "" {
		// Fallback picker when UI not bundled
		if r.URL.Path == "/" {
			g.handleIndex(w, r)
			return
		}
		http.Error(w, "PUBLIC_DIR not configured (WebUI not found)", http.StatusServiceUnavailable)
		return
	}
	// SPA-ish: missing files → index.html for non-api
	path := r.URL.Path
	if path == "/" {
		path = "/index.html"
	}
	full := filepath.Join(dir, filepath.Clean("/"+path))
	if !strings.HasPrefix(full, dir) {
		http.NotFound(w, r)
		return
	}
	if st, err := os.Stat(full); err != nil || st.IsDir() {
		// try index
		http.ServeFile(w, r, filepath.Join(dir, "index.html"))
		return
	}
	if ct, ok := staticContentTypes[strings.ToLower(filepath.Ext(full))]; ok {
		w.Header().Set("Content-Type", ct)
	}
	http.ServeFile(w, r, full)
}

// PUT session meta on hub: body includes machine + keys; fan-out not needed — require machine.
func (g *gateway) handleSessionMetaPut(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		g.handleAggregateSessionMeta(w, r)
		return
	}
	g.handleProxiedAPI(w, r)
}

// warm log
func init() {
	_ = time.Now
}
