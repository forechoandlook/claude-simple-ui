// Gateway — public-facing multi-machine relay (Go binary).
//
// Machines (Node client.js) connect via WS to /machine-connect and register.
// Browsers pick a machine; HTTP + chat/shell WebSockets are forwarded over
// the machine control channel. Protocol matches the original gateway.js.
//
//   register:   client → gateway   { type, machineId, meta }
//   ping/pong:  gateway ↔ client
//   HTTP:       http-req / http-res
//   WS tunnel:  ws-open / ws-ready / ws-error / ws-msg / ws-close
package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

// Set via: go build -ldflags "-X main.version=..."
var version = "dev"

func newID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	// 8-4-4-4-12
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

const (
	httpTimeout       = 30 * time.Second
	streamIdleTimeout = 60 * time.Second // no chunk/end received from edge within this window
	tunnelTimeout     = 10 * time.Second
	maxBodyBytes      = 25 << 20 // 25 MiB
	pingInterval         = 30 * time.Second
	browserPingInterval  = 30 * time.Second
	browserPongWait      = 75 * time.Second
	browserWriteTimeout  = 10 * time.Second
)

var (
	upgrader = websocket.Upgrader{
		CheckOrigin:       func(r *http.Request) bool { return true },
		ReadBufferSize:    1024 * 64,
		WriteBufferSize:   1024 * 64,
		// Compress text frames (chat deltas, shell) over mobile links.
		EnableCompression: true,
	}
	wsPathRe = regexp.MustCompile(`^/machine/([^/]+)(/ws/.+)$`)
)

// ── control-plane message ─────────────────────────────────────────────────────

type ctrlMsg struct {
	Type      string            `json:"type"`
	MachineID string            `json:"machineId,omitempty"`
	Meta      map[string]any    `json:"meta,omitempty"`
	ReqID     string            `json:"reqId,omitempty"`
	Method    string            `json:"method,omitempty"`
	Path      string            `json:"path,omitempty"`
	Headers   map[string]string `json:"headers,omitempty"`
	Body      string            `json:"body,omitempty"`
	// Encoding is "base64" when Body holds binary (file downloads). Empty = UTF-8 text.
	Encoding string `json:"encoding,omitempty"`
	Status   int    `json:"status,omitempty"`
	TunnelID string `json:"tunnelId,omitempty"`
	Query    string `json:"query,omitempty"`
	Data     string `json:"data,omitempty"`
	Message  string `json:"message,omitempty"`
}

// bodyBytes decodes Body according to Encoding (base64 for binary downloads).
func (m *ctrlMsg) bodyBytes() []byte {
	if m == nil {
		return nil
	}
	if strings.EqualFold(m.Encoding, "base64") {
		decoded, err := base64.StdEncoding.DecodeString(m.Body)
		if err == nil {
			return decoded
		}
		// Tolerate missing padding from older edges.
		decoded, err = base64.RawStdEncoding.DecodeString(m.Body)
		if err == nil {
			return decoded
		}
	}
	return []byte(m.Body)
}

// needsBase64ReqBody reports whether a request body must be base64 on the
// control channel. JSON cannot carry invalid UTF-8; string(b) + marshal would
// corrupt image/file uploads (POST /api/upload-image, etc.).
func needsBase64ReqBody(contentType string, b []byte) bool {
	if len(b) == 0 {
		return false
	}
	ct := strings.ToLower(strings.TrimSpace(contentType))
	if i := strings.IndexByte(ct, ';'); i >= 0 {
		ct = strings.TrimSpace(ct[:i])
	}
	if ct == "" {
		return !utf8.Valid(b)
	}
	if strings.HasPrefix(ct, "text/") ||
		ct == "application/json" ||
		ct == "application/javascript" ||
		ct == "application/x-www-form-urlencoded" ||
		strings.HasSuffix(ct, "+json") ||
		strings.HasSuffix(ct, "+xml") {
		return !utf8.Valid(b)
	}
	return true
}

// encodeProxyBody prepares a request body for the machine control JSON channel.
func encodeProxyBody(contentType string, b []byte) (body, encoding string) {
	if len(b) == 0 {
		return "", ""
	}
	if needsBase64ReqBody(contentType, b) {
		return base64.StdEncoding.EncodeToString(b), "base64"
	}
	return string(b), ""
}

// ── machine registry ──────────────────────────────────────────────────────────

type machine struct {
	id          string
	conn        *websocket.Conn
	meta        map[string]any
	connectedAt int64
	writeMu     sync.Mutex
}

func (m *machine) send(v any) error {
	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	_ = m.conn.SetWriteDeadline(time.Now().Add(15 * time.Second))
	return m.conn.WriteJSON(v)
}

type pendingHTTP struct {
	ch chan *ctrlMsg
}

type pendingTunnel struct {
	ch chan error
}

// Serialized writes to a browser websocket (data path + keepalive ping).
type browserSock struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (b *browserSock) write(mt int, data []byte) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	_ = b.conn.SetWriteDeadline(time.Now().Add(browserWriteTimeout))
	return b.conn.WriteMessage(mt, data)
}

type gateway struct {
	token string
	store *hubStore

	mu       sync.RWMutex
	machines map[string]*machine

	httpMu  sync.Mutex
	pending map[string]*pendingHTTP

	tunMu         sync.Mutex
	pendingTun    map[string]*pendingTunnel
	activeTunnels map[string]*browserSock // tunnelId → browser WS
}

func newGateway(token string) *gateway {
	dataDir := os.Getenv("HUB_DATA_DIR")
	if dataDir == "" {
		dataDir = os.Getenv("DATA_DIR")
	}
	if dataDir == "" {
		dataDir = filepath.Join(".", "hub-data")
	}
	return &gateway{
		token:         token,
		store:         newHubStore(dataDir),
		machines:      make(map[string]*machine),
		pending:       make(map[string]*pendingHTTP),
		pendingTun:    make(map[string]*pendingTunnel),
		activeTunnels: make(map[string]*browserSock),
	}
}

func (g *gateway) getMachine(id string) *machine {
	g.mu.RLock()
	defer g.mu.RUnlock()
	return g.machines[id]
}

func (g *gateway) setMachine(id string, m *machine) {
	g.mu.Lock()
	defer g.mu.Unlock()
	// replace previous connection for same id
	if old, ok := g.machines[id]; ok && old.conn != m.conn {
		_ = old.conn.Close()
	}
	g.machines[id] = m
}

func (g *gateway) deleteMachine(id string, conn *websocket.Conn) {
	g.mu.Lock()
	defer g.mu.Unlock()
	cur, ok := g.machines[id]
	if !ok || (conn != nil && cur.conn != conn) {
		return
	}
	delete(g.machines, id)
}

func (g *gateway) listMachines() []map[string]any {
	g.mu.RLock()
	defer g.mu.RUnlock()
	out := make([]map[string]any, 0, len(g.machines))
	for id, m := range g.machines {
		item := map[string]any{
			"id":          id,
			"connectedAt": m.connectedAt,
			"online":      true,
		}
		for k, v := range m.meta {
			item[k] = v
		}
		out = append(out, item)
	}
	return out
}

// ── HTTP proxy via control channel ────────────────────────────────────────────

func (g *gateway) forwardHTTP(machineID, method, path string, headers map[string]string, body, bodyEncoding string) (*ctrlMsg, error) {
	m := g.getMachine(machineID)
	if m == nil {
		return nil, fmt.Errorf(`machine "%s" not connected`, machineID)
	}
	reqID := newID()
	ch := make(chan *ctrlMsg, 1)
	g.httpMu.Lock()
	g.pending[reqID] = &pendingHTTP{ch: ch}
	g.httpMu.Unlock()
	defer func() {
		g.httpMu.Lock()
		delete(g.pending, reqID)
		g.httpMu.Unlock()
	}()

	err := m.send(ctrlMsg{
		Type:     "http-req",
		ReqID:    reqID,
		Method:   method,
		Path:     path,
		Headers:  headers,
		Body:     body,
		Encoding: bodyEncoding,
	})
	if err != nil {
		return nil, err
	}

	select {
	case res := <-ch:
		return res, nil
	case <-time.After(httpTimeout):
		return nil, fmt.Errorf("machine request timed out")
	}
}

// forwardHTTPStream proxies an HTTP request to the edge machine and writes
// the response straight to w as it arrives, so long-lived responses (SSE)
// stream through the hub instead of buffering in full on the edge side.
//
// The edge (client.js) replies either with a single legacy "http-res"
// (status+headers+full body — used for ordinary requests) or, for streamed
// responses, "http-res-start" (status+headers) followed by zero or more
// "http-chunk" messages and a terminating "http-end".
func (g *gateway) forwardHTTPStream(machineID, method, path string, headers map[string]string, body, bodyEncoding string, w http.ResponseWriter) error {
	m := g.getMachine(machineID)
	if m == nil {
		return fmt.Errorf(`machine "%s" not connected`, machineID)
	}
	reqID := newID()
	ch := make(chan *ctrlMsg, 64)
	g.httpMu.Lock()
	g.pending[reqID] = &pendingHTTP{ch: ch}
	g.httpMu.Unlock()
	defer func() {
		g.httpMu.Lock()
		delete(g.pending, reqID)
		g.httpMu.Unlock()
	}()

	if err := m.send(ctrlMsg{
		Type:     "http-req",
		ReqID:    reqID,
		Method:   method,
		Path:     path,
		Headers:  headers,
		Body:     body,
		Encoding: bodyEncoding,
	}); err != nil {
		return err
	}

	flusher, _ := w.(http.Flusher)
	headersWritten := false
	writeHead := func(status int, hdrs map[string]string) {
		// Edge client.js uses fetch(), which auto-decompresses gzip/br and
		// still returns Content-Encoding. Body on the control channel is
		// always plain text — never re-advertise compression to the browser.
		skip := map[string]bool{
			"transfer-encoding": true,
			"connection":        true,
			"keep-alive":        true,
			"content-encoding":  true,
			"content-length":    true, // recompute below for one-shot bodies
		}
		for k, v := range hdrs {
			if skip[strings.ToLower(k)] {
				continue
			}
			w.Header().Set(k, v)
		}
		if status == 0 {
			status = http.StatusOK
		}
		w.WriteHeader(status)
		headersWritten = true
	}

	timeout := httpTimeout
	for {
		select {
		case msg, ok := <-ch:
			if !ok {
				return nil
			}
			switch msg.Type {
			case "http-res": // legacy one-shot reply (non-streamed)
				bodyBytes := msg.bodyBytes()
				// Content-Length of the decoded body (encoding headers stripped in writeHead).
				// Always recompute: edge may advertise pre-base64 or wrong length.
				w.Header().Set("Content-Length", fmt.Sprintf("%d", len(bodyBytes)))
				writeHead(msg.Status, msg.Headers)
				_, _ = w.Write(bodyBytes)
				return nil
			case "http-res-start":
				writeHead(msg.Status, msg.Headers)
				if flusher != nil {
					flusher.Flush()
				}
				timeout = streamIdleTimeout
			case "http-chunk":
				if !headersWritten {
					writeHead(200, nil)
				}
				_, _ = w.Write([]byte(msg.Data))
				if flusher != nil {
					flusher.Flush()
				}
				timeout = streamIdleTimeout
			case "http-end":
				if !headersWritten {
					writeHead(200, nil)
				}
				return nil
			}
		case <-time.After(timeout):
			if !headersWritten {
				return fmt.Errorf("machine request timed out")
			}
			return nil // best effort: close out whatever streamed so far
		}
	}
}

func (g *gateway) openTunnel(machineID, tunnelID, path, query string) error {
	m := g.getMachine(machineID)
	if m == nil {
		return fmt.Errorf(`machine "%s" not connected`, machineID)
	}
	ch := make(chan error, 1)
	g.tunMu.Lock()
	g.pendingTun[tunnelID] = &pendingTunnel{ch: ch}
	g.tunMu.Unlock()
	defer func() {
		g.tunMu.Lock()
		delete(g.pendingTun, tunnelID)
		g.tunMu.Unlock()
	}()

	if err := m.send(ctrlMsg{
		Type:     "ws-open",
		TunnelID: tunnelID,
		Path:     path,
		Query:    query,
	}); err != nil {
		return err
	}

	select {
	case err := <-ch:
		return err
	case <-time.After(tunnelTimeout):
		return fmt.Errorf("tunnel open timed out")
	}
}

func (g *gateway) handleMachineMessage(msg *ctrlMsg) {
	switch msg.Type {
	case "pong":
		return
	case "http-res", "http-res-start", "http-chunk", "http-end":
		g.httpMu.Lock()
		p := g.pending[msg.ReqID]
		g.httpMu.Unlock()
		if p != nil {
			// Streaming responses consist of a sequence of control messages.  Do
			// not silently discard a chunk when the HTTP writer is briefly busy:
			// applying backpressure here preserves the SSE event boundary and lets
			// the websocket/TCP stack pace the edge instead.
			p.ch <- msg
		}
	case "ws-ready":
		g.tunMu.Lock()
		p := g.pendingTun[msg.TunnelID]
		g.tunMu.Unlock()
		if p != nil {
			select {
			case p.ch <- nil:
			default:
			}
		}
	case "ws-error":
		g.tunMu.Lock()
		p := g.pendingTun[msg.TunnelID]
		g.tunMu.Unlock()
		if p != nil {
			err := fmt.Errorf("%s", msg.Message)
			if msg.Message == "" {
				err = fmt.Errorf("tunnel error")
			}
			select {
			case p.ch <- err:
			default:
			}
		}
	case "ws-msg":
		g.tunMu.Lock()
		browser := g.activeTunnels[msg.TunnelID]
		g.tunMu.Unlock()
		if browser != nil {
			_ = browser.write(websocket.TextMessage, []byte(msg.Data))
		}
	case "ws-close":
		g.tunMu.Lock()
		browser := g.activeTunnels[msg.TunnelID]
		delete(g.activeTunnels, msg.TunnelID)
		g.tunMu.Unlock()
		if browser != nil {
			_ = browser.conn.Close()
		}
	}
}

// ── HTTP handlers ─────────────────────────────────────────────────────────────

func (g *gateway) handleMachinesAPI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(g.listMachines())
}

func (g *gateway) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if mid := r.URL.Query().Get("machine"); mid != "" {
		http.Redirect(w, r, "/machine/"+mid+"/", http.StatusFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(pickerHTML))
}

func (g *gateway) handleMachineHTTP(w http.ResponseWriter, r *http.Request) {
	// /machine/:id/...
	rest := strings.TrimPrefix(r.URL.Path, "/machine/")
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) == 0 || parts[0] == "" {
		http.Error(w, "machine id required", http.StatusBadRequest)
		return
	}
	machineID := parts[0]
	if g.getMachine(machineID) == nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": fmt.Sprintf(`Machine "%s" not connected`, machineID),
		})
		return
	}

	fwdPath := "/"
	if len(parts) == 2 && parts[1] != "" {
		fwdPath = "/" + parts[1]
	}
	if r.URL.RawQuery != "" {
		fwdPath += "?" + r.URL.RawQuery
	}

	var bodyStr, bodyEncoding string
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		limited := io.LimitReader(r.Body, maxBodyBytes+1)
		b, err := io.ReadAll(limited)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if len(b) > maxBodyBytes {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		bodyStr, bodyEncoding = encodeProxyBody(r.Header.Get("Content-Type"), b)
	}

	headers := map[string]string{}
	for k, vals := range r.Header {
		if len(vals) == 0 {
			continue
		}
		lk := strings.ToLower(k)
		if lk == "connection" || lk == "keep-alive" || lk == "transfer-encoding" || lk == "upgrade" {
			continue
		}
		headers[k] = vals[0]
	}
	headers["Host"] = "localhost"

	if err := g.forwardHTTPStream(machineID, r.Method, fwdPath, headers, bodyStr, bodyEncoding, w); err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
	}
}

// ── WebSocket: machine control ────────────────────────────────────────────────

func (g *gateway) handleMachineConnect(w http.ResponseWriter, r *http.Request) {
	token := r.Header.Get("X-Machine-Token")
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	if token != g.token {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[gateway] upgrade machine: %v", err)
		return
	}

	var machineID string
	defer func() {
		_ = conn.Close()
		if machineID != "" {
			g.deleteMachine(machineID, conn)
			log.Printf("[gateway] Machine disconnected: %s", machineID)
		}
	}()

	// Heartbeat writer
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		t := time.NewTicker(pingInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				m := &machine{conn: conn}
				// use write via temporary lock if registered
				g.mu.RLock()
				reg := g.machines[machineID]
				g.mu.RUnlock()
				if reg != nil && reg.conn == conn {
					_ = reg.send(ctrlMsg{Type: "ping"})
				} else {
					// not registered yet — raw write
					m.writeMu.Lock()
					_ = conn.WriteJSON(ctrlMsg{Type: "ping"})
					m.writeMu.Unlock()
				}
			}
		}
	}()

	conn.SetReadLimit(maxBodyBytes + 1024*1024)
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))

		var msg ctrlMsg
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg.Type == "register" {
			machineID = msg.MachineID
			if machineID == "" {
				continue
			}
			meta := msg.Meta
			if meta == nil {
				meta = map[string]any{}
			}
			g.setMachine(machineID, &machine{
				id:          machineID,
				conn:        conn,
				meta:        meta,
				connectedAt: time.Now().UnixMilli(),
			})
			log.Printf("[gateway] Machine registered: %s", machineID)
			continue
		}
		g.handleMachineMessage(&msg)
	}
}

// ── WebSocket: browser tunnel ─────────────────────────────────────────────────

// openBrowserTunnel upgrades the browser connection and relays through a machine.
// edgeQuery is the query string sent to the edge (must include edge auth).
func (g *gateway) openBrowserTunnel(w http.ResponseWriter, r *http.Request, machineID, wsPath, edgeQuery string) {
	if g.getMachine(machineID) == nil {
		http.Error(w, "Machine not connected", http.StatusServiceUnavailable)
		return
	}

	browser, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[gateway] upgrade browser: %v", err)
		return
	}
	defer browser.Close()

	tunnelID := newID()
	if edgeQuery != "" && !strings.HasPrefix(edgeQuery, "?") {
		edgeQuery = "?" + edgeQuery
	}

	if err := g.openTunnel(machineID, tunnelID, wsPath, edgeQuery); err != nil {
		log.Printf("[gateway] Tunnel open failed: %v", err)
		_ = browser.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "Tunnel failed"))
		return
	}

	sock := &browserSock{conn: browser}
	_ = browser.SetReadDeadline(time.Now().Add(browserPongWait))
	browser.SetPongHandler(func(string) error {
		return browser.SetReadDeadline(time.Now().Add(browserPongWait))
	})

	g.tunMu.Lock()
	g.activeTunnels[tunnelID] = sock
	g.tunMu.Unlock()
	defer func() {
		g.tunMu.Lock()
		delete(g.activeTunnels, tunnelID)
		g.tunMu.Unlock()
		if m := g.getMachine(machineID); m != nil {
			_ = m.send(ctrlMsg{Type: "ws-close", TunnelID: tunnelID})
		}
	}()

	done := make(chan struct{})
	defer close(done)
	go func() {
		t := time.NewTicker(browserPingInterval)
		defer t.Stop()
		for {
			select {
			case <-done:
				return
			case <-t.C:
				if err := sock.write(websocket.PingMessage, nil); err != nil {
					_ = browser.Close()
					return
				}
			}
		}
	}()

	for {
		_, data, err := browser.ReadMessage()
		if err != nil {
			return
		}
		m := g.getMachine(machineID)
		if m == nil {
			return
		}
		if err := m.send(ctrlMsg{
			Type:     "ws-msg",
			TunnelID: tunnelID,
			Data:     string(data),
		}); err != nil {
			return
		}
	}
}

// Unified UI paths: /ws/chat?token=hubJwt&machine=id  → edge /ws/chat?token=MACHINE_TOKEN
func (g *gateway) handleHubBrowserWS(w http.ResponseWriter, r *http.Request) {
	tok := r.URL.Query().Get("token")
	if tok == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if _, err := g.verifyHubToken(tok); err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	machineID := r.URL.Query().Get("machine")
	if machineID == "" {
		http.Error(w, "machine query required", http.StatusBadRequest)
		return
	}
	// Edge accepts MACHINE_TOKEN as hub-forwarded auth.
	// Preserve shell/chat query params (cwd, cols, rows, …); drop browser token/machine.
	q := url.Values{}
	q.Set("token", g.token)
	q.Set("hub", "1")
	for _, key := range []string{"cwd", "cols", "rows", "sessionId", "agent"} {
		if v := r.URL.Query().Get(key); v != "" {
			q.Set(key, v)
		}
	}
	edgeQuery := "?" + q.Encode()
	g.openBrowserTunnel(w, r, machineID, r.URL.Path, edgeQuery)
}

// Legacy: /machine/:id/ws/...
func (g *gateway) handleLegacyBrowserWS(w http.ResponseWriter, r *http.Request, machineID, wsPath string) {
	edgeQuery := "token=" + url.QueryEscape(g.token) + "&hub=1"
	// If browser already sent a hub token, still use machine token toward edge
	g.openBrowserTunnel(w, r, machineID, wsPath, edgeQuery)
}

// ── router ────────────────────────────────────────────────────────────────────

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// CORS-ish: hub is same-origin for UI; machines connect separately
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Machine-Id")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// WebSocket upgrades
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		if r.URL.Path == "/machine-connect" {
			g.handleMachineConnect(w, r)
			return
		}
		// Unified UI websockets
		if r.URL.Path == "/ws/chat" || r.URL.Path == "/ws/shell" {
			g.handleHubBrowserWS(w, r)
			return
		}
		if m := wsPathRe.FindStringSubmatch(r.URL.Path); m != nil {
			g.handleLegacyBrowserWS(w, r, m[1], m[2])
			return
		}
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	path := r.URL.Path

	switch {
	case path == "/healthz":
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
		return
	case path == "/api/hub":
		g.handleHubInfo(w, r)
		return
	case path == "/api/machines":
		// public list (ids only useful when logged in UI still needs it before login for empty state)
		if r.Method == http.MethodGet {
			writeJSON(w, g.listMachines())
			return
		}
	case path == "/api/auth/status":
		g.handleAuthStatus(w, r)
		return
	case path == "/api/auth/login":
		g.handleAuthLogin(w, r)
		return
	case path == "/api/auth/register":
		g.handleAuthRegister(w, r)
		return
	case path == "/api/sessions" && r.Method == http.MethodGet:
		g.handleAggregateSessions(w, r)
		return
	case path == "/api/projects" && r.Method == http.MethodGet:
		g.handleAggregateProjects(w, r)
		return
	case path == "/api/activity" && r.Method == http.MethodGet:
		g.handleAggregateActivity(w, r)
		return
	case path == "/api/sessions/meta":
		g.handleSessionMeta(w, r)
		return
	case path == "/api/projects/notes":
		g.handleProjectNotes(w, r)
		return
	case strings.HasPrefix(path, "/api/"):
		g.handleProxiedAPI(w, r)
		return
	case strings.HasPrefix(path, "/machine/"):
		if wsPathRe.MatchString(path) {
			http.Error(w, "websocket endpoint", http.StatusUpgradeRequired)
			return
		}
		// Legacy direct machine HTTP proxy (optional deep link)
		g.handleMachineHTTP(w, r)
		return
	default:
		// Static WebUI (unified)
		g.handleStatic(w, r)
	}
}

func main() {
	token := os.Getenv("MACHINE_TOKEN")
	if token == "" {
		log.Fatal("MACHINE_TOKEN is required (shared secret with edge machines)")
	}
	addr := os.Getenv("GATEWAY_ADDR")
	if addr == "" {
		port := os.Getenv("GATEWAY_PORT")
		if port == "" {
			port = "8080"
		}
		addr = ":" + port
	}

	g := newGateway(token)
	srv := &http.Server{
		Addr:              addr,
		Handler:           g,
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      2 * time.Minute,
	}

	log.Printf("Hub %s listening on %s", version, addr)
	log.Printf("Hub data dir:    %s (session meta + project notes)", g.store.dir)
	log.Printf("WebUI: embedded in binary (PUBLIC_DIR overrides)")
	log.Printf("Edges register:  ws://<host>/machine-connect  (header X-Machine-Token)")
	log.Printf("Hub login:       HUB_USERNAME / HUB_PASSWORD (default admin / MACHINE_TOKEN)")
	log.Printf("Health:          http://<host>/healthz")
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

const pickerHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Select machine</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; max-width: 520px; margin: 80px auto; padding: 0 16px; }
    h1 { font-size: 1.2rem; margin-bottom: 8px; }
    .sub { color: #888; font-size: 0.85rem; margin-bottom: 24px; }
    .machine { display:flex; justify-content:space-between; align-items:center; gap:12px;
               border:1px solid #4444; border-radius:8px; padding:12px 16px; margin-bottom:12px; }
    .machine a { text-decoration:none; font-weight:600; color:#3b82f6; }
    .meta { color:#888; font-size:0.8rem; flex:1; text-align:right; }
    .dot { width:8px; height:8px; border-radius:50%; background:#22c55e; flex-shrink:0; }
    .dot.offline { background:#ef4444; }
    #empty { color:#888; }
  </style>
</head>
<body>
  <h1>Choose a machine</h1>
  <p class="sub">Claude Simple multi-machine gateway</p>
  <div id="list"><p id="empty">Loading…</p></div>
  <script>
    async function load() {
      const res = await fetch('/api/machines');
      const machines = await res.json();
      const el = document.getElementById('list');
      if (!machines.length) { el.innerHTML = '<p id="empty">No machines connected.</p>'; return; }
      el.innerHTML = machines.map(m =>
        '<div class="machine">' +
          '<a href="/machine/' + encodeURIComponent(m.id) + '/">' + escapeHtml(m.id) + '</a>' +
          '<span class="meta">' + escapeHtml((m.hostname||'') + ' · ' + (m.platform||'')) + '</span>' +
          '<span class="dot ' + (m.online ? '' : 'offline') + '"></span>' +
        '</div>'
      ).join('');
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }
    load();
    setInterval(load, 5000);
  </script>
</body>
</html>
`
