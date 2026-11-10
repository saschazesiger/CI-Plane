package api

import "testing"

func TestLocalName(t *testing.T) {
	for host, want := range map[string]bool{
		"192.168.1.10:8080": true, "[fd00::1]:8080": true, "localhost:8080": true, "server:8080": true,
		"server.lan": true, "nas.local:8080": true, "box.tailnet.ts.net:8080": true, "ci.example.com:8080": true,
		"rebind.evil.example:8080": false, "evil.example": false, "": false,
	} {
		if got := localName(host, []string{" CI.example.com "}); got != want {
			t.Errorf("localName(%q) = %v, want %v", host, got, want)
		}
	}
}
