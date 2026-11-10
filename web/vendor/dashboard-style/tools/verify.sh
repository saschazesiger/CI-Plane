#!/usr/bin/env sh
# Verifies a copy of Dashboard-Style against its SHA256SUMS, without network
# and without Node (POSIX sh; needs sha256sum or shasum, find, sort, diff).
#
#   sh <copy>/tools/verify.sh            the copy this file sits in
#   sh <copy>/tools/verify.sh <path>     another copy (or a dist/)
#
# Exit 0 when every file matches, 1 on any difference. The same check as
# `vendor.sh --check` (check_dir below is that function, word for word; a
# test keeps the two in step) and as tools/verify.mjs: every file except
# SHA256SUMS listed as "<sha256>  <path>", sorted with LC_ALL=C, nothing
# missing, changed or added, no symbolic link.
set -eu

ME=verify.sh

die() { echo "$ME: $*" >&2; exit 1; }

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$@"
  else die "needs sha256sum or shasum"; fi
}

# Writes "<hash>  <path>" lines for every file below the current directory
# except SHA256SUMS, sorted by path (byte order, like the build).
sums() {
  find . -type f ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort | while IFS= read -r file; do
    sha256 "$file"
  done
}

# Verifies <dir>/SHA256SUMS (the copy's tools/verify.sh holds the same
# function and tools/verify.mjs the same rules; a test keeps them in step):
# every listed file matches, nothing is missing,
# nothing unlisted was added (a symbolic link neither: the file listing
# cannot see it, so any link fails the check).
check_dir() {
  dir=$1
  [ -f "$dir/SHA256SUMS" ] || die "$dir/SHA256SUMS not found"
  links=$(cd "$dir" && find . -type l | sed 's|^\./||' | LC_ALL=C sort)
  if [ -n "$links" ]; then
    echo "$ME: $dir contains symbolic links, which SHA256SUMS cannot cover:" >&2
    printf '%s\n' "$links" >&2
    return 1
  fi
  expected=$(cd "$dir" && tr -d '\r' < SHA256SUMS)
  actual=$(cd "$dir" && sums)
  if [ "$expected" != "$actual" ]; then
    echo "$ME: $dir does not match its SHA256SUMS:" >&2
    printf '%s\n' "$expected" > "${TMPDIR:-/tmp}/ds-expected.$$"
    printf '%s\n' "$actual" > "${TMPDIR:-/tmp}/ds-actual.$$"
    diff "${TMPDIR:-/tmp}/ds-expected.$$" "${TMPDIR:-/tmp}/ds-actual.$$" >&2 || true
    rm -f "${TMPDIR:-/tmp}/ds-expected.$$" "${TMPDIR:-/tmp}/ds-actual.$$"
    return 1
  fi
}

case ${1:-} in
  -h|--help)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac
[ $# -le 1 ] || die "usage: sh tools/verify.sh [<copy>]"
dir=${1:-$(cd "$(dirname "$0")/.." && pwd)}
check_dir "$dir" || exit 1
echo "$dir matches its SHA256SUMS$(sed -n 's/^version \(.*\)/ (\1)/p' "$dir/VERSION" 2>/dev/null || true)"
