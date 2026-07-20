package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// Lightweight hub-user JWT (HMAC-SHA256). Browser holds this; MACHINE_TOKEN never leaves the hub.

type hubClaims struct {
	Sub string `json:"sub"`
	Exp int64  `json:"exp"`
}

func (g *gateway) hubUser() string {
	if u := os.Getenv("HUB_USERNAME"); u != "" {
		return u
	}
	return "admin"
}

func (g *gateway) hubPassword() string {
	// Prefer dedicated hub password; fall back to MACHINE_TOKEN for tiny deploys
	if p := os.Getenv("HUB_PASSWORD"); p != "" {
		return p
	}
	return g.token
}

func (g *gateway) jwtSecret() []byte {
	if s := os.Getenv("HUB_JWT_SECRET"); s != "" {
		return []byte(s)
	}
	return []byte(g.token)
}

func (g *gateway) issueToken(username string) (string, error) {
	c := hubClaims{Sub: username, Exp: time.Now().Add(7 * 24 * time.Hour).Unix()}
	raw, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, g.jwtSecret())
	_, _ = mac.Write([]byte(payload))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return payload + "." + sig, nil
}

func (g *gateway) verifyHubToken(token string) (*hubClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return nil, fmt.Errorf("bad token")
	}
	mac := hmac.New(sha256.New, g.jwtSecret())
	_, _ = mac.Write([]byte(parts[0]))
	expect := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expect), []byte(parts[1])) {
		return nil, fmt.Errorf("bad signature")
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, err
	}
	var c hubClaims
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	if c.Exp < time.Now().Unix() {
		return nil, fmt.Errorf("expired")
	}
	return &c, nil
}

func bearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(strings.ToLower(h), "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	if t := r.URL.Query().Get("token"); t != "" {
		return t
	}
	return ""
}

func (g *gateway) requireHubAuth(w http.ResponseWriter, r *http.Request) (*hubClaims, bool) {
	tok := bearerToken(r)
	if tok == "" {
		http.Error(w, `{"error":"No token"}`, http.StatusUnauthorized)
		return nil, false
	}
	c, err := g.verifyHubToken(tok)
	if err != nil {
		http.Error(w, `{"error":"Invalid token"}`, http.StatusForbidden)
		return nil, false
	}
	return c, true
}

func (g *gateway) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	// Hub always has a configured password (env); first-run "register" not required
	writeJSON(w, map[string]any{
		"needsSetup": false,
		"hub":        true,
	})
}

func (g *gateway) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, `{"error":"bad json"}`, http.StatusBadRequest)
		return
	}
	user := g.hubUser()
	pass := g.hubPassword()
	if body.Username != user || body.Password != pass {
		http.Error(w, `{"error":"Invalid credentials"}`, http.StatusUnauthorized)
		return
	}
	tok, err := g.issueToken(user)
	if err != nil {
		http.Error(w, `{"error":"token error"}`, http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]any{
		"token": tok,
		"user":  map[string]any{"id": 1, "username": user},
	})
}

func (g *gateway) handleAuthRegister(w http.ResponseWriter, r *http.Request) {
	// Hub uses env credentials only
	http.Error(w, `{"error":"Hub auth is configured via HUB_USERNAME / HUB_PASSWORD (or MACHINE_TOKEN)"}`, http.StatusBadRequest)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
