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
		{[]string{"self-hosted", "ci-plane"}, "standard", ""},
		{[]string{"ci-plane"}, "standard", ""},
		{[]string{"ci-plane", "large"}, "large", ""},
		// Labels of earlier versions mean one of the two sizes.
		{[]string{"Self-Hosted", "Linux", "X64", "CI-Plane", "Size-L"}, "large", ""},
		{[]string{"self-hosted", "ci-plane", "size-s"}, "standard", ""},
		{[]string{"self-hosted", "ci-plane", "size-s", "size-m"}, "standard", ""},
		{[]string{"self-hosted", "ci-plane", "gpu"}, "", "unknown label \"gpu\""},
		{[]string{"self-hosted", "ci-plane", "size-s", "size-xl"}, "", "two sizes"},
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

func TestTwoSizes(t *testing.T) {
	old := DefaultSettings()
	old.Sizes = []Size{
		{Name: "size-s", CPUs: 1, MemMB: 4096}, {Name: "size-m", CPUs: 2, MemMB: 6144},
		{Name: "size-l", CPUs: 3, MemMB: 8192}, {Name: "size-xl", CPUs: 6, MemMB: 16384},
	}
	old.DefaultSize = "size-m"
	s, changed := old.TwoSizes()
	if !changed || len(s.Sizes) != 2 || s.DefaultSize != SizeStandard {
		t.Fatalf("%+v", s)
	}
	std, large := s.Sizes[0], s.Sizes[1]
	if std.Name != SizeStandard || std.CPUs != 2 || std.MemMB != 6144 || strings.Join(std.Aliases, ",") != "size-s,size-m" {
		t.Errorf("standard: %+v", std)
	}
	// The largest: no job gets less memory than it had.
	if large.Name != SizeLarge || large.CPUs != 6 || large.MemMB != 16384 || strings.Join(large.Aliases, ",") != "size-l,size-xl" {
		t.Errorf("large: %+v", large)
	}
	for label, want := range map[string]string{"size-s": SizeStandard, "size-m": SizeStandard, "size-l": SizeLarge, "size-xl": SizeLarge, "large": SizeLarge} {
		if got, reason := s.Match([]string{"ci-plane", label}); got != want {
			t.Errorf("%s: %q %q", label, got, reason)
		}
	}
	// A runner carries every label that means its size.
	if got := strings.Join(s.RunnerLabels("size-s"), ","); got != "self-hosted,linux,x64,ci-plane,standard,size-s,size-m" {
		t.Errorf("labels: %s", got)
	}
	if _, again := s.TwoSizes(); again {
		t.Error("changed twice")
	}
	// One size only: large is twice that.
	one := DefaultSettings()
	one.Sizes, one.DefaultSize = []Size{{Name: "big", CPUs: 4, MemMB: 8192}}, "big"
	s, _ = one.TwoSizes()
	if s.Sizes[1].MemMB != 16384 || strings.Join(s.Sizes[0].Aliases, ",") != "big" || len(s.Sizes[1].Aliases) != 0 {
		t.Errorf("one size: %+v", s.Sizes)
	}
	if PoolPauseSec(1) != 60 || PoolPauseSec(4) != 3600 || PoolPauseSec(99) != 12*3600 || PoolPauseSec(0) != 0 {
		t.Error("pauses")
	}
}
