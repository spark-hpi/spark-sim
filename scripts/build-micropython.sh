#!/usr/bin/env bash
# Build the custom MicroPython WebAssembly binary for the SPARK simulator.
#
# Output: vendor/micropython/micropython.mjs and vendor/micropython/micropython.wasm
# Docs:   vendor/micropython/BUILD.md (versions, flags, design, how to rebuild)
#
# What it does (reproducibly, all versions pinned below):
#   1. installs emsdk $EMSDK_VERSION   into $WORKDIR/emsdk        (not in the repo)
#   2. clones MicroPython $MP_TAG      into $WORKDIR/micropython  (not in the repo)
#   3. applies vendor/micropython/patches/*.patch to a clean checkout
#   4. builds ports/webassembly with the custom variant vendor/micropython/variants/spark
#   5. copies micropython.mjs + micropython.wasm into vendor/micropython/
#
# Usage:
#   scripts/build-micropython.sh                    build and install
#   scripts/build-micropython.sh --upstream-tests   also run MicroPython's own test
#                                                   suite, normally and in GC torture
#                                                   mode (takes ~10 minutes)
#
# Environment:
#   SPARK_MP_WORKDIR  work directory for toolchain and sources
#                     (default: ~/.cache/spark-micropython-build)
#   JOBS              parallel make jobs (default: number of CPUs)
#
# Requirements: git, make, python3, node (>= 18), a host C compiler (for mpy-cross).
set -euo pipefail

# ----------------------------------------------------------------------------- pinned versions
# MicroPython release matching the npm package @micropython/micropython-webassembly-pyscript@1.29.0-6.
MP_TAG="v1.29.0"
MP_COMMIT="0fd6c573ea815774668bbb16b8e197c8822368b2"
# emsdk: MicroPython's CI (tools/ci.sh, ci_webassembly_setup) installs "latest"; 6.0.8 was the
# latest release when v1.29.0 and the npm package were published (2026-08-24).
EMSDK_VERSION="6.0.8"
# Link-time optimisation level (see variants/spark/mpconfigvariant.mk).
LINK_OPT="-O2"

# ----------------------------------------------------------------------------- paths
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$ROOT/vendor/micropython"
VARIANT_DIR="$VENDOR/variants/spark"
WORKDIR="${SPARK_MP_WORKDIR:-${XDG_CACHE_HOME:-$HOME/.cache}/spark-micropython-build}"
EMSDK_DIR="$WORKDIR/emsdk"
MP_DIR="$WORKDIR/micropython"
PORT_DIR="$MP_DIR/ports/webassembly"
BUILD_NAME="build-spark"

if [ -z "${JOBS:-}" ]; then
    JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
fi

UPSTREAM_TESTS=0
for arg in "$@"; do
    case "$arg" in
        --upstream-tests) UPSTREAM_TESTS=1 ;;
        -h|--help) awk 'NR > 1 && /^#/ { print; next } NR > 1 { exit }' "$0"; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
filesize() { wc -c < "$1" | tr -d ' '; }

for tool in git make python3 node; do
    command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done
mkdir -p "$WORKDIR"

# ----------------------------------------------------------------------------- 1. emsdk
log "emsdk $EMSDK_VERSION in $EMSDK_DIR"
if [ ! -d "$EMSDK_DIR/.git" ]; then
    git clone https://github.com/emscripten-core/emsdk.git "$EMSDK_DIR"
fi
git -C "$EMSDK_DIR" fetch --tags --quiet origin || true
git -C "$EMSDK_DIR" -c advice.detachedHead=false checkout --quiet "$EMSDK_VERSION"
if ! (cd "$EMSDK_DIR" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION") \
        >"$WORKDIR/emsdk-install.log" 2>&1; then
    cat "$WORKDIR/emsdk-install.log" >&2
    exit 1
fi
# shellcheck disable=SC1091
source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1
EMCC_VERSION="$(emcc --version | head -n1)"
case "$EMCC_VERSION" in
    *" $EMSDK_VERSION "*) ;;
    *) echo "unexpected emcc version: $EMCC_VERSION" >&2; exit 1 ;;
esac
echo "$EMCC_VERSION"

# ----------------------------------------------------------------------------- 2. MicroPython source
log "MicroPython $MP_TAG in $MP_DIR"
if [ ! -d "$MP_DIR/.git" ]; then
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$MP_TAG" \
        https://github.com/micropython/micropython.git "$MP_DIR"
fi
HEAD_COMMIT="$(git -C "$MP_DIR" rev-parse HEAD)"
if [ "$HEAD_COMMIT" != "$MP_COMMIT" ]; then
    git -C "$MP_DIR" fetch --depth 1 origin "refs/tags/$MP_TAG:refs/tags/$MP_TAG"
    git -C "$MP_DIR" -c advice.detachedHead=false checkout --quiet "$MP_TAG"
    HEAD_COMMIT="$(git -C "$MP_DIR" rev-parse HEAD)"
fi
[ "$HEAD_COMMIT" = "$MP_COMMIT" ] || { echo "$MP_TAG is $HEAD_COMMIT, expected $MP_COMMIT" >&2; exit 1; }

# ----------------------------------------------------------------------------- 3. patches
log "applying patches"
git -C "$MP_DIR" checkout --quiet -- .
for patch in "$VENDOR"/patches/*.patch; do
    echo "  $(basename "$patch")"
    git -C "$MP_DIR" apply --whitespace=nowarn "$patch"
done

# ----------------------------------------------------------------------------- 4. build
log "building (variant: $VARIANT_DIR)"
make -C "$PORT_DIR" VARIANT_DIR="$VARIANT_DIR" submodules >/dev/null
make -C "$MP_DIR/mpy-cross" -j"$JOBS" >/dev/null
rm -rf "${PORT_DIR:?}/$BUILD_NAME"
make -C "$PORT_DIR" -j"$JOBS" VARIANT_DIR="$VARIANT_DIR" BUILD="$BUILD_NAME" SPARK_LINK_OPT="$LINK_OPT"

# ----------------------------------------------------------------------------- 5. install
log "installing into $VENDOR"
cp "$PORT_DIR/$BUILD_NAME/micropython.mjs" "$PORT_DIR/$BUILD_NAME/micropython.wasm" "$VENDOR/"
for f in micropython.mjs micropython.wasm; do
    printf '  %-17s %8s bytes  sha256 %s\n' "$f" "$(filesize "$VENDOR/$f")" "$(sha256 "$VENDOR/$f")"
done
echo "  MicroPython $MP_TAG ($MP_COMMIT), $EMCC_VERSION, link $LINK_OPT"

# ----------------------------------------------------------------------------- optional: upstream tests
if [ "$UPSTREAM_TESTS" = 1 ]; then
    # The test suite needs `unittest`, which the spark variant does not freeze; build a test
    # flavour with the pyscript variant's manifest (same C code, more frozen Python modules).
    log "building test flavour (frozen unittest etc.)"
    rm -rf "${PORT_DIR:?}/build-spark-test"
    make -C "$PORT_DIR" -j"$JOBS" VARIANT_DIR="$VARIANT_DIR" BUILD=build-spark-test \
        SPARK_LINK_OPT="$LINK_OPT" FROZEN_MANIFEST=variants/pyscript/manifest.py >/dev/null
    cp "$VENDOR/tools/gc-torture-cli.mjs" "$PORT_DIR/build-spark-test/"

    # run_suite <name> <mjs> [run-tests.py args...]: run the suite and compare the failing
    # tests with vendor/micropython/tools/expected-upstream-failures.txt.
    status=0
    run_suite() {
        local name="$1" mjs="$2"
        shift 2
        (cd "$MP_DIR/tests" && MICROPY_MICROPYTHON_MJS="../ports/webassembly/build-spark-test/$mjs" \
            python3 ./run-tests.py -t webassembly -j"$JOBS" "$@" >"$WORKDIR/upstream-tests-$name.log" 2>&1) || true
        grep -E "tests (performed|passed)" "$WORKDIR/upstream-tests-$name.log" || true
        python3 -I - "$name" "$MP_DIR/tests/results/_results.json" \
            "$VENDOR/tools/expected-upstream-failures.txt" <<'EOF' || status=1
import json, sys
name, results_file, expected_file = sys.argv[1:]
failed = sorted(t for t, result, *_ in json.load(open(results_file))["results"] if result == "fail")
expected = set()
for line in open(expected_file):
    fields = line.split("#")[0].split()
    if len(fields) == 2 and fields[0] == name:
        expected.add(fields[1])
unexpected = [t for t in failed if t not in expected]
print(f"{len(failed)} failed, {len(failed) - len(unexpected)} of them expected")
for t in unexpected:
    print(f"UNEXPECTED FAILURE: {t}")
for t in sorted(expected - set(failed)):
    print(f"(expected failure now passes: {t})")
sys.exit(1 if unexpected else 0)
EOF
    }

    log "MicroPython test suite (128 KiB heap)"
    run_suite normal micropython.mjs
    log "MicroPython test suite in GC torture mode (collection on every allocation)"
    run_suite torture gc-torture-cli.mjs -d basics micropython misc float extmod stress unicode
    echo
    if [ "$status" = 0 ]; then echo "upstream tests: OK (only expected failures)"; else echo "upstream tests: UNEXPECTED FAILURES (logs in $WORKDIR)"; fi
    exit "$status"
fi
