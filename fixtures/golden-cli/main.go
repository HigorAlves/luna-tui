// tally reads "name amount" lines from stdin and prints the total per name.
package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
)

// Run reads "name amount" lines from in and writes "name: total" lines to out, sorted by name.
func Run(in io.Reader, out io.Writer) error {
	totals := map[string]int{}
	scanner := bufio.NewScanner(in)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 2 {
			return fmt.Errorf("bad line %q", scanner.Text())
		}
		amount, err := strconv.Atoi(fields[1])
		if err != nil {
			return fmt.Errorf("bad amount %q", fields[1])
		}
		totals[fields[0]] = amount
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	names := make([]string, 0, len(totals))
	for name := range totals {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(out, "%s: %d\n", name, totals[name])
	}
	return nil
}

func main() {
	if err := Run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "tally:", err)
		os.Exit(1)
	}
}
