package main

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Hub-owned UI metadata (favorites, notes, renames, project goals).
// Kept on the hub so edge machines stay stateless for annotations and
// npm/package upgrades on edges cannot wipe user notes.

type sessionMetaEntry struct {
	Favorite  bool   `json:"favorite"`
	Notes     string `json:"notes"`
	Title     string `json:"title"`
	Hidden    bool   `json:"hidden"`
	UpdatedAt int64  `json:"updatedAt"`
}

type projectNoteEntry struct {
	Goal      string `json:"goal"`
	Notes     string `json:"notes"`
	UpdatedAt int64  `json:"updatedAt"`
}

type metaNoteEntry struct {
	ID        string   `json:"id"`
	Scope     string   `json:"scope"`
	Title     string   `json:"title"`
	Content   string   `json:"content"`
	Cwd       string   `json:"cwd,omitempty"`
	SessionID string   `json:"sessionId,omitempty"`
	Agent     string   `json:"agent,omitempty"`
	MachineID string   `json:"machineId,omitempty"`
	Pinned    bool     `json:"pinned"`
	Tags      []string `json:"tags,omitempty"`
	CreatedAt int64    `json:"createdAt"`
	UpdatedAt int64    `json:"updatedAt"`
}

type notificationEntry struct {
	ID            string         `json:"id"`
	User          string         `json:"user"`
	Type          string         `json:"type"`
	Title         string         `json:"title"`
	Body          string         `json:"body"`
	Unread        bool           `json:"unread"`
	CreatedAt     int64          `json:"createdAt"`
	SessionID     string         `json:"sessionId,omitempty"`
	Agent         string         `json:"agent,omitempty"`
	MachineID     string         `json:"machineId,omitempty"`
	Cwd           string         `json:"cwd,omitempty"`
	ProjectName   string         `json:"projectName,omitempty"`
	PromptPreview string         `json:"promptPreview,omitempty"`
	ResultPreview string         `json:"resultPreview,omitempty"`
	Meta          map[string]any `json:"meta,omitempty"`
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

type hubStore struct {
	mu   sync.Mutex
	dir  string
	// sessionMeta: "machineId:agent:sessionId" → entry
	sessionMeta map[string]sessionMetaEntry
	// projectNotes: "machineId\x1frootPath" → entry
	projectNotes map[string]projectNoteEntry
	// metaNotes: noteID → entry
	metaNotes map[string]metaNoteEntry
	// notifications: newest first
	notifications []notificationEntry
	// importOnce: pull legacy edge meta once if hub file was empty
	importedMeta bool
}

func newHubStore(dir string) *hubStore {
	if dir == "" {
		dir = filepath.Join(".", "hub-data")
	}
	_ = os.MkdirAll(dir, 0o755)
	s := &hubStore{
		dir:          dir,
		sessionMeta:  map[string]sessionMetaEntry{},
		projectNotes: map[string]projectNoteEntry{},
		metaNotes:    map[string]metaNoteEntry{},
		notifications: []notificationEntry{},
	}
	s.load()
	return s
}

func (s *hubStore) metaPath() string  { return filepath.Join(s.dir, "session_meta.json") }
func (s *hubStore) notesPath() string { return filepath.Join(s.dir, "project_notes.json") }
func (s *hubStore) notificationsPath() string {
	return filepath.Join(s.dir, "notifications.json")
}
func (s *hubStore) metaNotesPath() string {
	return filepath.Join(s.dir, "meta_notes.json")
}

func (s *hubStore) load() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if raw, err := os.ReadFile(s.metaPath()); err == nil {
		var m map[string]sessionMetaEntry
		if json.Unmarshal(raw, &m) == nil && m != nil {
			s.sessionMeta = m
		}
	}
	if raw, err := os.ReadFile(s.notesPath()); err == nil {
		var m map[string]projectNoteEntry
		if json.Unmarshal(raw, &m) == nil && m != nil {
			s.projectNotes = m
		}
	}
	if raw, err := os.ReadFile(s.metaNotesPath()); err == nil {
		var m map[string]metaNoteEntry
		if json.Unmarshal(raw, &m) == nil && m != nil {
			s.metaNotes = m
		}
	}
	if raw, err := os.ReadFile(s.notificationsPath()); err == nil {
		var rows []notificationEntry
		if json.Unmarshal(raw, &rows) == nil && rows != nil {
			s.notifications = rows
		}
	}
	log.Printf("[hub-store] loaded dir=%s sessionMeta=%d projectNotes=%d",
		s.dir, len(s.sessionMeta), len(s.projectNotes))
}

func (s *hubStore) saveSessionMetaLocked() error {
	raw, err := json.MarshalIndent(s.sessionMeta, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.metaPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.metaPath())
}

func (s *hubStore) saveProjectNotesLocked() error {
	raw, err := json.MarshalIndent(s.projectNotes, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.notesPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.notesPath())
}

func (s *hubStore) saveMetaNotesLocked() error {
	raw, err := json.MarshalIndent(s.metaNotes, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.metaNotesPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.metaNotesPath())
}

func (s *hubStore) saveNotificationsLocked() error {
	raw, err := json.MarshalIndent(s.notifications, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.notificationsPath() + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.notificationsPath())
}

func sessionMetaKey(machineID, agent, sessionID string) string {
	if agent == "" {
		agent = "claude"
	}
	if machineID == "" {
		return agent + ":" + sessionID
	}
	return machineID + ":" + agent + ":" + sessionID
}

func projectNotesKey(machineID, root string) string {
	if machineID == "" {
		return root
	}
	return machineID + "\x1f" + root
}

func (s *hubStore) getAllSessionMeta() map[string]sessionMetaEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]sessionMetaEntry, len(s.sessionMeta))
	for k, v := range s.sessionMeta {
		out[k] = v
	}
	return out
}

func (s *hubStore) putSessionMeta(key string, next sessionMetaEntry) (sessionMetaEntry, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next.UpdatedAt = time.Now().UnixMilli()
	// Drop empty entries
	empty := !next.Favorite && next.Notes == "" && next.Title == "" && !next.Hidden
	if empty {
		delete(s.sessionMeta, key)
		if err := s.saveSessionMetaLocked(); err != nil {
			return sessionMetaEntry{}, false, err
		}
		return sessionMetaEntry{}, false, nil
	}
	s.sessionMeta[key] = next
	if err := s.saveSessionMetaLocked(); err != nil {
		return next, true, err
	}
	return next, true, nil
}

func (s *hubStore) getSessionMeta(key string) (sessionMetaEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.sessionMeta[key]
	return v, ok
}

func (s *hubStore) mergeImportedSessionMeta(entries map[string]sessionMetaEntry) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.importedMeta {
		return 0, nil
	}
	// Only import when hub store is empty (first boot after upgrade)
	if len(s.sessionMeta) > 0 {
		s.importedMeta = true
		return 0, nil
	}
	n := 0
	for k, v := range entries {
		if k == "" {
			continue
		}
		s.sessionMeta[k] = v
		n++
	}
	s.importedMeta = true
	if n == 0 {
		return 0, nil
	}
	if err := s.saveSessionMetaLocked(); err != nil {
		return n, err
	}
	return n, nil
}

func (s *hubStore) listNotifications(user string, limit int) []notificationEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	if limit <= 0 {
		limit = 50
	}
	out := make([]notificationEntry, 0, minInt(limit, len(s.notifications)))
	for _, row := range s.notifications {
		if user != "" && row.User != "" && row.User != user {
			continue
		}
		out = append(out, row)
		if len(out) >= limit {
			break
		}
	}
	return out
}

func (s *hubStore) unreadNotificationCount(user string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, row := range s.notifications {
		if user != "" && row.User != "" && row.User != user {
			continue
		}
		if row.Unread {
			n++
		}
	}
	return n
}

func (s *hubStore) addNotification(row notificationEntry) (notificationEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if row.ID == "" {
		row.ID = newMetaNoteID()
	}
	if row.Type == "" {
		row.Type = "session_done"
	}
	if row.CreatedAt == 0 {
		row.CreatedAt = time.Now().UnixMilli()
	}
	row.Unread = true
	s.notifications = append([]notificationEntry{row}, s.notifications...)
	if len(s.notifications) > 500 {
		s.notifications = s.notifications[:500]
	}
	return row, s.saveNotificationsLocked()
}

func (s *hubStore) markNotificationsRead(user string, ids []string) ([]notificationEntry, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var idSet map[string]struct{}
	if len(ids) > 0 {
		idSet = make(map[string]struct{}, len(ids))
		for _, id := range ids {
			idSet[id] = struct{}{}
		}
	}
	changed := false
	for i := range s.notifications {
		row := &s.notifications[i]
		if user != "" && row.User != "" && row.User != user {
			continue
		}
		if !row.Unread {
			continue
		}
		if idSet == nil {
			row.Unread = false
			changed = true
			continue
		}
		if _, ok := idSet[row.ID]; ok {
			row.Unread = false
			changed = true
		}
	}
	if changed {
		if err := s.saveNotificationsLocked(); err != nil {
			return nil, 0, err
		}
	}
	rows := make([]notificationEntry, 0, minInt(200, len(s.notifications)))
	unread := 0
	for _, row := range s.notifications {
		if user != "" && row.User != "" && row.User != user {
			continue
		}
		if row.Unread {
			unread++
		}
		if len(rows) < 200 {
			rows = append(rows, row)
		}
	}
	return rows, unread, nil
}

func (s *hubStore) getProjectNote(key string) projectNoteEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.projectNotes[key]; ok {
		return v
	}
	return projectNoteEntry{}
}

func (s *hubStore) putProjectNote(key string, next projectNoteEntry) (projectNoteEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next.UpdatedAt = time.Now().UnixMilli()
	if next.Goal == "" && next.Notes == "" {
		delete(s.projectNotes, key)
	} else {
		s.projectNotes[key] = next
	}
	if err := s.saveProjectNotesLocked(); err != nil {
		return next, err
	}
	return next, nil
}

func (s *hubStore) deleteProjectNote(key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.projectNotes, key)
	return s.saveProjectNotesLocked()
}

func (s *hubStore) sessionMetaCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessionMeta)
}

func (s *hubStore) listMetaNotes() []metaNoteEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]metaNoteEntry, 0, len(s.metaNotes))
	for _, v := range s.metaNotes {
		out = append(out, v)
	}
	return out
}

func (s *hubStore) getMetaNote(id string) (metaNoteEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.metaNotes[id]
	return v, ok
}

func (s *hubStore) putMetaNote(note metaNoteEntry) (metaNoteEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.metaNotes[note.ID] = note
	if err := s.saveMetaNotesLocked(); err != nil {
		return note, err
	}
	return note, nil
}

func (s *hubStore) deleteMetaNote(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.metaNotes, id)
	return s.saveMetaNotesLocked()
}
