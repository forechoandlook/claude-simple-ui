package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// mime.TypeByExtension falls back to the OS mime registry (/etc/mime.types),
// which is missing on minimal Linux images — that made .css/.js serve as
// text/plain and get MIME-blocked by strict browser checks.
var staticContentTypes = map[string]string{
	".css":          "text/css; charset=utf-8",
	".js":           "application/javascript; charset=utf-8",
	".mjs":          "application/javascript; charset=utf-8",
	".json":         "application/json; charset=utf-8",
	".webmanifest":  "application/manifest+json; charset=utf-8",
	".html":         "text/html; charset=utf-8",
	".svg":          "image/svg+xml",
	".png":          "image/png",
	".webp":         "image/webp",
	".ico":          "image/x-icon",
	".woff":         "font/woff",
	".woff2":        "font/woff2",
}

// Hub-mode API: one WebUI, many edge machines.

// Paths that the hub answers itself (not proxied to a single machine).
func (g *gateway) isHubLocalAPI(path string) bool {
	switch {
	case path == "/api/hub", path == "/api/machines",
		path == "/api/auth/status", path == "/api/auth/login", path == "/api/auth/register",
		path == "/api/notifications", path == "/api/notifications/read",
		path == "/api/sessions", path == "/api/projects", path == "/api/activity",
		path == "/api/sessions/meta",
		path == "/api/projects/notes",
		path == "/api/ai/notes",
		strings.HasPrefix(path, "/api/ai/notes/"):
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
			res, err := g.forwardHTTP(machineID, http.MethodGet, path, g.edgeHeaders(), "", "")
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
		res, err := g.forwardHTTP(only, http.MethodGet, fwd, g.edgeHeaders(), "", "")
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
	// One-time import from edges when hub store is empty (upgrade path).
	g.maybeImportSessionMetaFromEdges()
	out := map[string]any{}
	for k, v := range g.store.getAllSessionMeta() {
		out[k] = v
	}
	writeJSON(w, out)
}

func (g *gateway) handleNotifications(w http.ResponseWriter, r *http.Request) {
	claims, ok := g.requireHubAuth(w, r)
	if !ok {
		return
	}
	switch r.Method {
	case http.MethodGet:
		limit := 50
		if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil {
				limit = parsed
			}
		}
		if limit <= 0 || limit > 200 {
			limit = 50
		}
		writeJSON(w, map[string]any{
			"notifications": g.store.listNotifications(claims.Sub, limit),
			"unreadCount":   g.store.unreadNotificationCount(claims.Sub),
		})
	case http.MethodPost:
		var body struct {
			IDs []string `json:"ids"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil && err != io.EOF {
			http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
			return
		}
		rows, unread, err := g.store.markNotificationsRead(claims.Sub, body.IDs)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{
			"notifications": rows,
			"unreadCount":   unread,
		})
	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// maybeImportSessionMetaFromEdges copies edge .session_meta once into hub-data.
func (g *gateway) maybeImportSessionMetaFromEdges() {
	if g.store.sessionMetaCount() > 0 {
		return
	}
	merged := map[string]sessionMetaEntry{}
	for _, item := range g.fanInGET("/api/sessions/meta") {
		if item.Err != "" || item.Status >= 400 {
			continue
		}
		var m map[string]sessionMetaEntry
		if err := json.Unmarshal(item.Body, &m); err != nil {
			continue
		}
		for k, v := range m {
			// Prefer machine-prefixed keys for hub UI metaKey()
			key := k
			if item.MachineID != "" && !strings.HasPrefix(k, item.MachineID+":") {
				key = item.MachineID + ":" + k
			}
			merged[key] = v
		}
	}
	if n, err := g.store.mergeImportedSessionMeta(merged); err != nil {
		log.Printf("[hub-store] import session meta: %v", err)
	} else if n > 0 {
		log.Printf("[hub-store] imported %d session meta entries from edges", n)
	}
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

	var bodyStr, bodyEncoding string
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
		bodyStr, bodyEncoding = encodeProxyBody(r.Header.Get("Content-Type"), b)
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

	if err := g.forwardHTTPStream(machineID, r.Method, fwdPath, headers, bodyStr, bodyEncoding, w); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadGateway)
	}
}

// publicDir, when set (PUBLIC_DIR env), is preferred over the embed.FS so
// operators can ship UI fixes with rsync without rebuilding the binary.
var publicDir string

func (g *gateway) handleStatic(w http.ResponseWriter, r *http.Request) {
	// Disk PUBLIC_DIR wins when present; else embedded web/ from build.
	// Unknown non-API paths fall through to index.html (SPA).
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" || name == "." {
		name = "index.html"
	}

	if publicDir != "" {
		full := path.Join(publicDir, name)
		// prevent path escape
		if strings.HasPrefix(path.Clean(full), path.Clean(publicDir)) {
			if f, err := os.Open(full); err == nil {
				defer f.Close()
				st, err := f.Stat()
				if err == nil && !st.IsDir() {
					if ct, ok := staticContentTypes[strings.ToLower(path.Ext(name))]; ok {
						w.Header().Set("Content-Type", ct)
					}
					// Avoid sticky mobile SW/browser caches for JS modules during deploys.
					if strings.HasSuffix(name, ".js") || strings.HasSuffix(name, ".css") {
						w.Header().Set("Cache-Control", "no-cache")
					}
					http.ServeContent(w, r, name, st.ModTime(), f)
					return
				}
			}
			// SPA fallback on disk
			if name != "index.html" {
				if f, err := os.Open(path.Join(publicDir, "index.html")); err == nil {
					defer f.Close()
					st, _ := f.Stat()
					w.Header().Set("Content-Type", "text/html; charset=utf-8")
					w.Header().Set("Cache-Control", "no-cache")
					http.ServeContent(w, r, "index.html", st.ModTime(), f)
					return
				}
			}
		}
	}

	file, err := embeddedPublic.Open(name)
	if err != nil {
		name = "index.html"
		file, err = embeddedPublic.Open(name)
	}
	if err != nil {
		http.Error(w, "embedded WebUI is unavailable", http.StatusServiceUnavailable)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.IsDir() {
		http.NotFound(w, r)
		return
	}
	reader, ok := file.(io.ReadSeeker)
	if !ok {
		http.Error(w, "embedded WebUI asset is not seekable", http.StatusInternalServerError)
		return
	}
	if ct, ok := staticContentTypes[strings.ToLower(path.Ext(name))]; ok {
		w.Header().Set("Content-Type", ct)
	}
	if strings.HasSuffix(name, ".js") || strings.HasSuffix(name, ".css") {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, name, info.ModTime(), reader)
}

var embeddedPublic fs.FS

func init() {
	var err error
	embeddedPublic, err = fs.Sub(embeddedWeb, "web")
	if err != nil {
		panic(err)
	}
	if d := strings.TrimSpace(os.Getenv("PUBLIC_DIR")); d != "" {
		publicDir = d
		log.Printf("[hub] static UI from PUBLIC_DIR=%s (overrides embed)", publicDir)
	}
}

// Session meta lives on the hub (not on edges). GET returns full map;
// PUT upserts one entry keyed by machineId:agent:sessionId.
func (g *gateway) handleSessionMeta(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		g.handleAggregateSessionMeta(w, r)
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if _, ok := g.requireHubAuth(w, r); !ok {
		return
	}

	var body struct {
		SessionID string `json:"sessionId"`
		Agent     string `json:"agent"`
		MachineID string `json:"machineId"`
		Favorite  *bool  `json:"favorite"`
		Notes     *string `json:"notes"`
		Title     *string `json:"title"`
		Hidden    *bool  `json:"hidden"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	if body.SessionID == "" {
		http.Error(w, `{"error":"sessionId required"}`, http.StatusBadRequest)
		return
	}
	machineID := body.MachineID
	if machineID == "" {
		machineID = r.Header.Get("X-Machine-Id")
	}
	if machineID == "" {
		machineID = r.URL.Query().Get("machine")
	}
	agent := body.Agent
	if agent == "" {
		agent = "claude"
	}
	key := sessionMetaKey(machineID, agent, body.SessionID)
	prev, _ := g.store.getSessionMeta(key)
	next := prev
	if body.Favorite != nil {
		next.Favorite = *body.Favorite
	}
	if body.Notes != nil {
		next.Notes = *body.Notes
	}
	if body.Title != nil {
		t := strings.TrimSpace(*body.Title)
		if len(t) > 200 {
			t = t[:200]
		}
		next.Title = t
	}
	if body.Hidden != nil {
		next.Hidden = *body.Hidden
	}
	saved, ok, err := g.store.putSessionMeta(key, next)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusInternalServerError)
		return
	}
	if !ok {
		writeJSON(w, map[string]any{
			"success":   true,
			"key":       key,
			"favorite":  false,
			"notes":     "",
			"title":     "",
			"hidden":    false,
			"updatedAt": time.Now().UnixMilli(),
		})
		return
	}
	writeJSON(w, map[string]any{
		"success":   true,
		"key":       key,
		"favorite":  saved.Favorite,
		"notes":     saved.Notes,
		"title":     saved.Title,
		"hidden":    saved.Hidden,
		"updatedAt": saved.UpdatedAt,
	})
}

// Project notes / goals — hub-owned, keyed by machine + project root path.
func (g *gateway) handleProjectNotes(w http.ResponseWriter, r *http.Request) {
	if _, ok := g.requireHubAuth(w, r); !ok {
		return
	}
	machineID := r.Header.Get("X-Machine-Id")
	if machineID == "" {
		machineID = r.URL.Query().Get("machine")
	}

	switch r.Method {
	case http.MethodGet:
		root := r.URL.Query().Get("root")
		if root == "" {
			http.Error(w, `{"error":"root parameter required"}`, http.StatusBadRequest)
			return
		}
		ent := g.store.getProjectNote(projectNotesKey(machineID, root))
		writeJSON(w, map[string]any{
			"goal":      ent.Goal,
			"notes":     ent.Notes,
			"updatedAt": ent.UpdatedAt,
		})
		return

	case http.MethodPost, http.MethodPut:
		var body struct {
			Root      string  `json:"root"`
			Goal      *string `json:"goal"`
			Notes     *string `json:"notes"`
			MachineID string  `json:"machineId"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
			http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
			return
		}
		if body.Root == "" {
			http.Error(w, `{"error":"root required"}`, http.StatusBadRequest)
			return
		}
		if body.MachineID != "" {
			machineID = body.MachineID
		}
		key := projectNotesKey(machineID, body.Root)
		prev := g.store.getProjectNote(key)
		next := prev
		if body.Goal != nil {
			next.Goal = *body.Goal
		}
		if body.Notes != nil {
			next.Notes = *body.Notes
		}
		saved, err := g.store.putProjectNote(key, next)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{
			"success":   true,
			"goal":      saved.Goal,
			"notes":     saved.Notes,
			"updatedAt": saved.UpdatedAt,
		})
		return

	case http.MethodDelete:
		root := r.URL.Query().Get("root")
		if root == "" {
			http.Error(w, `{"error":"root parameter required"}`, http.StatusBadRequest)
			return
		}
		if err := g.store.deleteProjectNote(projectNotesKey(machineID, root)); err != nil {
			http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"success": true})
		return

	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

func newMetaNoteID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (g *gateway) handleMetaNotes(w http.ResponseWriter, r *http.Request) {
	if _, ok := g.requireHubAuth(w, r); !ok {
		return
	}

	pathParts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	noteID := ""
	if len(pathParts) >= 4 {
		noteID = strings.TrimSpace(pathParts[3])
	}
	machineID := r.Header.Get("X-Machine-Id")
	if machineID == "" {
		machineID = r.URL.Query().Get("machine")
	}

	switch r.Method {
	case http.MethodGet:
		if noteID != "" {
			note, ok := g.store.getMetaNote(noteID)
			if !ok {
				http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
				return
			}
			writeJSON(w, note)
			return
		}
		scope := strings.TrimSpace(r.URL.Query().Get("scope"))
		queryText := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
		cwd := r.URL.Query().Get("cwd")
		sessionID := r.URL.Query().Get("sessionId")
		agent := r.URL.Query().Get("agent")
		limit := 30
		if _, err := fmt.Sscanf(strings.TrimSpace(r.URL.Query().Get("limit")), "%d", &limit); err != nil {
			limit = 30
		}
		if limit <= 0 || limit > 200 {
			limit = 30
		}
		rows := g.store.listMetaNotes()
		filtered := make([]metaNoteEntry, 0, len(rows))
		for _, note := range rows {
			if machineID != "" && note.MachineID != machineID {
				continue
			}
			if scope != "" && scope != "all" && note.Scope != scope {
				continue
			}
			if cwd != "" && note.Cwd != cwd {
				continue
			}
			if sessionID != "" && note.SessionID != sessionID {
				continue
			}
			if agent != "" && note.Agent != agent {
				continue
			}
			if queryText != "" {
				hay := strings.ToLower(note.Title + "\n" + note.Content + "\n" + strings.Join(note.Tags, " "))
				if !strings.Contains(hay, queryText) {
					continue
				}
			}
			filtered = append(filtered, note)
		}
		sort.SliceStable(filtered, func(i, j int) bool {
			if filtered[i].Pinned != filtered[j].Pinned {
				return filtered[i].Pinned
			}
			return filtered[i].UpdatedAt > filtered[j].UpdatedAt
		})
		if len(filtered) > limit {
			filtered = filtered[:limit]
		}
		writeJSON(w, map[string]any{"notes": filtered})
		return

	case http.MethodPost, http.MethodPut:
		var body metaNoteEntry
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&body); err != nil {
			http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
			return
		}
		body.Title = strings.TrimSpace(body.Title)
		body.Content = strings.TrimSpace(body.Content)
		if body.Title == "" || body.Content == "" {
			http.Error(w, `{"error":"title and content required"}`, http.StatusBadRequest)
			return
		}
		if body.ID == "" {
			body.ID = newMetaNoteID()
		}
		now := time.Now().UnixMilli()
		if prev, ok := g.store.getMetaNote(body.ID); ok {
			body.CreatedAt = prev.CreatedAt
		} else {
			body.CreatedAt = now
		}
		body.UpdatedAt = now
		if body.MachineID == "" {
			body.MachineID = machineID
		}
		if body.Scope == "" {
			switch {
			case body.SessionID != "":
				body.Scope = "session"
			case body.Cwd != "":
				body.Scope = "project"
			default:
				body.Scope = "general"
			}
		}
		saved, err := g.store.putMetaNote(body)
		if err != nil {
			http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		writeJSON(w, saved)
		return

	case http.MethodDelete:
		if noteID == "" {
			http.Error(w, `{"error":"id required"}`, http.StatusBadRequest)
			return
		}
		if err := g.store.deleteMetaNote(noteID); err != nil {
			http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true})
		return

	default:
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
	}
}

// warm log
func init() {
	_ = time.Now
}
