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

type hubStore struct {
	mu   sync.Mutex
	dir  string
	// sessionMeta: "machineId:agent:sessionId" → entry
	sessionMeta map[string]sessionMetaEntry
	// projectNotes: "machineId\x1frootPath" → entry
	projectNotes map[string]projectNoteEntry
	// metaNotes: noteID → entry
	metaNotes map[string]metaNoteEntry
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
	}
	s.load()
	return s
}

func (s *hubStore) metaPath() string  { return filepath.Join(s.dir, "session_meta.json") }
func (s *hubStore) notesPath() string { return filepath.Join(s.dir, "project_notes.json") }
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
