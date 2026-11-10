package model

import (
	"strings"
	"testing"
)

func TestMatch(t *testing.T) {
	s := DefaultSettings()
	for _, c := range []struct {
		labels []string
		size   string
		reason string // substring; empty = handled
	}{
		{[]string{"self-hosted", "ci-plane"}, "size-m", ""},
		{[]string{"ci-plane"}, "size-m", ""},
		{[]string{"Self-Hosted", "Linux", "X64", "CI-Plane", "Size-L"}, "size-l", ""},
		{[]string{"self-hosted", "ci-plane", "size-s"}, "size-s", ""},
		{[]string{"self-hosted", "ci-plane", "gpu"}, "", "unknown label \"gpu\""},
		{[]string{"self-hosted", "ci-plane", "size-s", "size-m"}, "", "two sizes"},
		{[]string{"self-hosted", "ci-plane", "arm64"}, "", "unknown label"},
		{[]string{"self-hosted"}, "", "does not contain"},
		{[]string{"ubuntu-latest"}, "", "unknown label"},
	} {
		size, reason := s.Match(c.labels)
		if c.reason == "" {
			if reason != "" || size != c.size {
				t.Errorf("%v: size %q reason %q, want size %q", c.labels, size, reason, c.size)
			}
		} else if !strings.Contains(reason, c.reason) {
			t.Errorf("%v: reason %q, want it to contain %q", c.labels, reason, c.reason)
		}
	}
	s.DefaultSize = "gone"
	if _, reason := s.Match([]string{"ci-plane"}); !strings.Contains(reason, "default size") {
		t.Errorf("missing default size: %q", reason)
	}
}

func TestServes(t *testing.T) {
	s := DefaultSettings()
	medium, large := s.RunnerLabels("size-m"), s.RunnerLabels("size-l")
	for _, c := range []struct {
		runner, job []string
		want        bool
	}{
		{medium, []string{"self-hosted", "ci-plane"}, true},
		{large, []string{"self-hosted", "ci-plane"}, true}, // no size label: any runner
		{medium, []string{"self-hosted", "ci-plane", "size-m"}, true},
		{medium, []string{"self-hosted", "ci-plane", "size-l"}, false},
		{medium, []string{"SELF-HOSTED", "Linux", "CI-Plane"}, true},
		{medium, []string{"ubuntu-latest"}, false},
	} {
		if got := Serves(c.runner, c.job); got != c.want {
			t.Errorf("Serves(%v, %v) = %v", c.runner, c.job, got)
		}
	}
	if LabelKey([]string{"B", " a"}) != LabelKey([]string{"a", "b"}) {
		t.Error("LabelKey is not canonical")
	}
}
