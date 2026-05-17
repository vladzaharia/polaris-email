#!/bin/sh
# Fake wrangler binary used by exec_test.go. Echoes its arguments and a
# canonical version string, then exits 0 — unless the first argument is
# `fail`, in which case it writes "boom" to stderr and exits 2.

if [ "$1" = "fail" ]; then
    echo "boom" >&2
    exit 2
fi

if [ "$1" = "--version" ]; then
    echo "4.20.1"
    exit 0
fi

# Default: print each arg on its own line so tests can confirm capture.
for a in "$@"; do
    echo "$a"
done
