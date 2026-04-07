#!/usr/bin/env bash
# Start Code OSS loading its renderer scripts from a remote dev server.
#
# Usage:
#   ./scripts/code-remote-dev.sh <server-url> [extra code args...]
#
# <server-url> is the HTTP URL of the workbench HTML on the remote server.
# The remote machine must serve the compiled out/ directory over HTTP.
#
# Example setup:
#   On the remote machine (in the VS Code source root):
#     npx serve out -l 8080
#   Then forward the port locally:
#     ssh -L 8080:localhost:8080 user@remote
#   Then start Code OSS locally pointing at that server:
#     ./scripts/code-remote-dev.sh http://localhost:8080/vs/code/electron-browser/workbench/workbench-dev.html
#
# How it works:
#   The Electron main process loads the workbench HTML from the given URL.
#   The renderer then derives the module base URL from the server origin so
#   that all JS and CSS modules are also loaded from the remote server.
#   The Electron/Node main process (IPC, filesystem access, extensions) still
#   runs entirely on the local machine.

set -e

if [[ "$OSTYPE" == "darwin"* ]]; then
	realpath() { [[ $1 = /* ]] && echo "$1" || echo "$PWD/${1#./}"; }
	ROOT=$(dirname "$(dirname "$(realpath "$0")")")
else
	ROOT=$(dirname "$(dirname "$(readlink -f $0)")")
fi

SERVER_URL="${1}"

if [[ -z "${SERVER_URL}" ]]; then
	echo "Usage: $0 <server-url> [extra code args...]"
	echo ""
	echo "Example:"
	echo "  $0 http://localhost:8080/vs/code/electron-browser/workbench/workbench-dev.html"
	exit 1
fi

shift  # remove server-url from args so the rest are passed to code

export VSCODE_DEV=1
export VSCODE_DEV_SERVER_URL="${SERVER_URL}"

exec "${ROOT}/scripts/code.sh" "$@"
