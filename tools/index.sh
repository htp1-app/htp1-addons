#!/bin/bash
# tools/index.sh <release-tag> [<outdir>]
# Packs every addon and writes index.json: the catalog the HTP-1 reads from this repository.
# Download URLs point at the GitHub release <release-tag>, whose assets are the tarballs in <outdir>.

set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TAG="${1:-}"
OUT="${2:-$ROOT/dist}"
[[ -n "$TAG" ]] || { echo "usage: tools/index.sh <release-tag> [<outdir>]" >&2; exit 1; }
REPO_URL=$(git -C "$ROOT" remote get-url origin | sed -E 's#^git@github\.com:#https://github.com/#; s#\.git$##')

for PY in python3 python; do "$PY" -c pass >/dev/null 2>&1 && break; done

for d in "$ROOT"/addons/*/; do
    "$ROOT/tools/pack.sh" "$(basename "$d")" "$OUT" >/dev/null
done

"$PY" - "$ROOT" "$OUT" "$TAG" "$REPO_URL" <<'EOF'
import glob, hashlib, json, os, sys, datetime
root, out, tag, repo = sys.argv[1:5]
addons = []
for mf in sorted(glob.glob(os.path.join(root, "addons", "*", "addon.json"))):
    m = json.load(open(mf))
    name = "htp1-addon-%s-%s.tar.gz" % (m["id"], m["version"])
    path = os.path.join(out, name)
    entry = {k: m[k] for k in ("id", "version", "label", "summary", "requires") if k in m}
    entry["url"] = "%s/releases/download/%s/%s" % (repo, tag, name)
    entry["sha256"] = hashlib.sha256(open(path, "rb").read()).hexdigest()
    entry["size"] = os.path.getsize(path)
    addons.append(entry)
index = {"name": repo.rsplit("/", 1)[-1], "updated": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"), "addons": addons}
with open(os.path.join(root, "index.json"), "w", newline="
") as f:
    json.dump(index, f, indent=2); f.write("\n")
print("index.json: %d addons, release %s" % (len(addons), tag))
EOF
