package main

import (
	"strings"
	"testing"
)

func run(t *testing.T, input string) string {
	t.Helper()
	var out strings.Builder
	if err := Run(strings.NewReader(input), &out); err != nil {
		t.Fatalf("Run returned an error: %v", err)
	}
	return out.String()
}

func TestRunPrintsSortedTotals(t *testing.T) {
	if got := run(t, "bob 2\nalice 3\n"); got != "alice: 3\nbob: 2\n" {
		t.Fatalf("got %q", got)
	}
}

func TestRunSumsRepeatedNames(t *testing.T) {
	if got := run(t, "alice 3\nbob 1\nalice 4\n"); got != "alice: 7\nbob: 1\n" {
		t.Fatalf("got %q", got)
	}
}
