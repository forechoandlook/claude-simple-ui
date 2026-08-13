package main

import "testing"

func TestHandleMachineMessageForwardsAllStreamingHTTPMessages(t *testing.T) {
	g := newGateway("test-token")
	requestID := "stream-request"
	pending := &pendingHTTP{ch: make(chan *ctrlMsg, 4)}
	g.pending[requestID] = pending

	for _, typ := range []string{"http-res-start", "http-chunk", "http-end"} {
		g.handleMachineMessage(&ctrlMsg{Type: typ, ReqID: requestID})
		got := <-pending.ch
		if got.Type != typ {
			t.Fatalf("%s was not forwarded; got %s", typ, got.Type)
		}
	}
}
