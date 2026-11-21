#!/bin/sh
# Is <version> the newest release? Exit 0 if so, 1 if not (D-155).
#   .github/scripts/newest-release.sh 0.3.0
#
# Everything that moves a "latest" — the images' :latest tag, npm's latest
# dist-tag, downloads.crewaid.io/install.sh — asks this first, so re-running an
# older release's tag, or publishing a prerelease, never points "latest" back at
# something older. "Newest" is the highest plain x.y.z among the repository's
# v* tags, compared numerically; a prerelease (x.y.z-rc.1) is never newest.
# Needs the tags: check out with fetch-depth: 0.
set -eu
version="${1:?usage: newest-release.sh <x.y.z>}"
case "$version" in
  *[!0-9.]* | '' ) echo "v$version is a prerelease or not a release version: not the newest"; exit 1 ;;
esac
newest="$(git tag -l 'v[0-9]*' | sed 's/^v//' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1)"
if [ "$newest" = "$version" ]; then
  echo "v$version is the newest release"
  exit 0
fi
echo "v$version is not the newest release (v${newest:-none} is)"
exit 1
