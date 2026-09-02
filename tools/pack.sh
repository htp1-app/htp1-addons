#!/bin/bash
# tools/pack.sh <id> [<outdir>]
# Writes <outdir>/htp1-addon-<id>-<version>.tar.gz and its .sha256.
# The tarball is addons/<id>/ minus build/ and tests/, under one top-level directory named <id>.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ID="${1:-}"
OUT="${2:-$ROOT/dist}"
[[ -n "$ID" ]] || { echo "usage: tools/pack.sh <id> [<outdir>]" >&2; exit 1; }
SRC="$ROOT/addons/$ID"
[[ -f "$SRC/addon.json" ]] || { echo "pack: $SRC has no addon.json" >&2; exit 1; }

for PY in python3 python; do "$PY" -c pass >/dev/null 2>&1 && break; done
mkdir -p "$OUT"

# Modes are set here rather than taken from the checkout, so the result is the same on every host.
NAME=$("$PY" - "$SRC" "$ID" "$OUT" <<'EOF'
import json, os, sys, tarfile
src, aid, out = sys.argv[1:4]
ver = json.load(open(os.path.join(src, "addon.json")))["version"]
name = "htp1-addon-%s-%s.tar.gz" % (aid, ver)
skip = {"build", "tests"}
with tarfile.open(os.path.join(out, name), "w:gz") as tar:
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src).replace(os.sep, "/")
        dirs[:] = sorted(d for d in dirs if not (rel == "." and d in skip))
        top = rel.split("/")[0] if rel != "." else ""
        for d in dirs:
            ti = tarfile.TarInfo(aid + "/" + (d if rel == "." else rel + "/" + d))
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            tar.addfile(ti)
        for f in sorted(files):
            path = os.path.join(root, f)
            ti = tar.gettarinfo(path, aid + "/" + (f if rel == "." else rel + "/" + f))
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = "root"
            ti.mode = 0o755 if top in ("bin", "hooks") else 0o644
            with open(path, "rb") as fh:
                tar.addfile(ti, fh)
print(name)
EOF
)
(cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256")
echo "$OUT/$NAME ($(du -h "$OUT/$NAME" | cut -f1))"
