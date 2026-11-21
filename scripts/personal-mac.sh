#!/usr/bin/env bash
# Build one pinned arm64 package and install that same bundle on each Mac.
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }
sha256() { /usr/bin/shasum -a 256 "$1" | awk '{print $1}'; }

[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || fail 'Requires Apple Silicon macOS.'

case ${1:-} in
build)
	[[ $# == 2 ]] || fail 'Usage: bash scripts/personal-mac.sh build /absolute/path/to/omp-personal.zip'
	zip=$2
	[[ $zip == /*.zip && ! -e $zip ]] || fail 'Use an absolute .zip path that does not yet exist.'
	gui=$(cd "$(dirname "$0")/.." && pwd -P)
	core=$(cd "$gui/../.." && pwd -P)
	[[ $gui == "$core/packages/gui" && -f $core/packages/coding-agent/package.json ]] ||
		fail 'Build from packages/gui within the pinned Core checkout.'
	cd "$gui"
	pin=$(bun -e 'console.log((await Bun.file("sidecar-source.json").json()).commit)')
	[[ $(git -C "$core" rev-parse HEAD) == "$pin" ]] || fail "Check out the pinned Core ${pin} first."
	[[ -z $(git -C "$core" status --porcelain --untracked-files=no) && -z $(git status --porcelain) ]] ||
		fail 'Commit tracked changes before building; the package must match the pinned sources.'
	stage=$(mktemp -d "$(dirname "$zip")/.omp-build.XXXXXXXX")
	trap 'rm -rf "$stage"' EXIT
	bun run check:types
	bun run build:omp
	bun run build
	bun run electron-builder --config electron-builder.personal.cjs --mac --arm64 --dir --publish never \
		"--config.directories.output=$stage/out"
	app="$stage/out/mac-arm64/omp.app"
	/usr/bin/codesign --verify --deep --strict "$app"
	if /usr/libexec/PlistBuddy -c 'Print CFBundleURLTypes' "$app/Contents/Info.plist" >/dev/null 2>&1 ||
		[[ -e "$app/Contents/Resources/app-update.yml" ]]; then
		fail 'Personal builds must not register deep links or an updater feed.'
	fi
	# electron-builder re-signs the embedded executable. Probe the shipped binary.
	PI_CODING_AGENT_DIR="$stage/agent" bun scripts/smoke-sidecar.mjs "$app/Contents/Resources/omp"
	/usr/bin/ditto -c -k --keepParent "$app" "$stage/omp.zip"
	mv "$stage/omp.zip" "$zip"
	printf '\nGUI: %s\nCore: %s\nSHA256: %s\nArtifact: %s\n' "$(git rev-parse HEAD)" "$pin" "$(sha256 "$zip")" "$zip"
	;;
install)
	[[ $# == 3 ]] || fail 'Usage: bash scripts/personal-mac.sh install /path/to/omp-personal.zip SHA256'
	[[ $(sha256 "$2") == "$3" ]] || fail 'Package checksum mismatch.'
	app="$HOME/Applications/omp Remote.app"
	cli="$HOME/.local/bin/omp"
	state="$HOME/.local/share/omp-remote"
	[[ ! -L $app && ! -d $cli ]] || fail 'Unexpected existing GUI or CLI installation; stopping.'
	if ps -axo command= | awk -v exe="$app/Contents/MacOS/omp" 'index($0, exe) == 1 {found=1} END {exit !found}'; then
		fail 'Quit omp Remote before upgrading. Existing remote Core instances do not need to stop.'
	fi
	mkdir -p "$HOME/Applications" "$(dirname "$cli")" "$state"
	stage=$(mktemp -d "$HOME/Applications/.omp-install.XXXXXXXX")
	cli_stage=
	cleanup() {
		if [[ -d $stage/previous.app && ! -e $app ]]; then mv "$stage/previous.app" "$app" || return; fi
		rm -rf "$stage"
		if [[ -n $cli_stage ]]; then rm -f "$cli_stage"; fi
	}
	trap cleanup EXIT
	/usr/bin/ditto -x -k "$2" "$stage"
	bundle="$stage/omp.app"
	/usr/bin/codesign --verify --deep --strict "$bundle"
	[[ $(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$bundle/Contents/Info.plist") == sh.omp.gui.personal ]] ||
		fail 'Not a personal-channel omp bundle.'
	[[ $(/usr/bin/file -b "$bundle/Contents/Resources/omp") == *'arm64'* ]] || fail 'Wrong Core architecture.'
	PI_CODING_AGENT_DIR="$stage/agent" "$bundle/Contents/Resources/omp" --smoke-test
	cli_stage=$(mktemp "$(dirname "$cli")/.omp.XXXXXXXX")
	/usr/bin/install -m 755 "$bundle/Contents/Resources/omp" "$cli_stage"
	if [[ -e $cli && ! -e $state/previous-omp ]]; then cp -p "$cli" "$state/previous-omp"; fi
	if [[ -e $app ]]; then mv "$app" "$stage/previous.app"; fi
	mv "$bundle" "$app"
	if ! mv -f "$cli_stage" "$cli"; then
		mv "$app" "$bundle"
		exit 1
	fi
	printf 'Installed %s and %s\n' "$app" "$cli"
	;;
*) fail 'Usage: bash scripts/personal-mac.sh {build|install} ...' ;;
esac
