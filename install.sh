#!/bin/sh
# Downloads a versioned application package, verifies it, then runs its private
# runtime. No repository checkout, npm, system Node.js, or container engine.
set -eu
umask 077
fail() { printf 'openwebprint: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" != 0 ] || fail 'Run as your normal user, without sudo.'
case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) fail 'Supported operating systems: Linux and macOS. Windows support is planned in issue #14.' ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail 'Supported processors: x64 and arm64.' ;;
esac
command -v curl >/dev/null 2>&1 || fail 'curl is required. Install it using your operating system package manager.'
command -v tar >/dev/null 2>&1 || fail 'tar is required.'
if command -v sha256sum >/dev/null 2>&1; then checksum=sha256sum
elif command -v shasum >/dev/null 2>&1; then checksum=shasum
else fail 'A SHA-256 tool (sha256sum or shasum) is required.'; fi
# An explicit version avoids resolving "latest" separately for the two downloads.
version=${OPENWEBPRINT_VERSION:-}
if [ -z "$version" ]; then
  resolved=$(curl --proto '=https' --proto-redir '=https' -fsSL -o /dev/null -w '%{url_effective}' 'https://github.com/Florian-Cullmann/openwebprint/releases/latest') || fail 'No release found. Check the Releases page and your internet connection.'
  version=${resolved##*/}
fi
case "$version" in
  v[0-9]*) ;;
  *) fail 'OPENWEBPRINT_VERSION must be a release tag such as v0.1.0.' ;;
esac
case "$version" in *[!a-zA-Z0-9.-]*) fail 'Invalid release tag.' ;; esac
base="https://github.com/Florian-Cullmann/openwebprint/releases/download/$version"
name="openwebprint-$platform-$arch"
temporary=$(mktemp -d) || fail 'Could not create a temporary folder.'
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
printf 'Downloading openwebprint %s for %s/%s…\n' "$version" "$platform" "$arch"
curl --proto '=https' --proto-redir '=https' -fsSL "$base/$name.tar.gz" -o "$temporary/$name.tar.gz" || fail 'Package download failed.'
curl --proto '=https' --proto-redir '=https' -fsSL "$base/$name.tar.gz.sha256" -o "$temporary/checksum" || fail 'Checksum download failed.'
read -r expected remainder < "$temporary/checksum" || fail 'Invalid package checksum.'
[ "${#expected}" = 64 ] || fail 'Invalid package checksum.'
if [ "$checksum" = sha256sum ]; then actual=$(sha256sum "$temporary/$name.tar.gz");
else actual=$(shasum -a 256 "$temporary/$name.tar.gz"); fi
actual=${actual%% *}
[ "$expected" = "$actual" ] || fail 'Checksum mismatch. The package was not installed.'
tar -xzf "$temporary/$name.tar.gz" -C "$temporary" || fail 'Could not unpack the release.'
"$temporary/$name/runtime/node" "$temporary/$name/scripts/install/manage.mjs" "$@"
