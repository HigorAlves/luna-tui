package main

import (
	"strings"
	"testing"
)

func TestAcceptCommentsAndBlankLinesAreIgnored(t *testing.T) {
	var out strings.Builder
	if err := Run(strings.NewReader("# note\n\nalice 3\n  \nalice 2\n"), &out); err != nil {
		t.Fatalf("Run returned an error: %v", err)
	}
	if out.String() != "alice: 5\n" {
		t.Fatalf("got %q", out.String())
	}
}
