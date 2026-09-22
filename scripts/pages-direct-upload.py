#!/usr/bin/env python3
"""Deploy the built Vite app to Cloudflare Pages via the Direct Upload API.

Replicates what `wrangler pages deploy` does, without wrangler, so it can
run on the connected `custom.cloudflare` credential (auth goes through the
authd surrogate — no raw secrets anywhere in this script):

  1. Bundle the Pages Advanced-Mode `_worker.js` with esbuild
     (serves /api/cyber-feed via workers/cyber-feed-proxy.js, everything
     else from static assets).
  2. Hash every file in dist/ with wrangler's exact content hash
     (blake3(base64(content) + ext)[:32 hex] — verified against wrangler's
     own test vector at startup).
  3. Create the Pages project if missing (production_branch = --branch).
  4. GET upload-token -> POST /pages/assets/check-missing ->
     POST /pages/assets/upload (missing files only, bucketed) ->
     POST /pages/assets/upsert-hashes. Asset calls use the short-lived
     upload JWT as Bearer, exactly like wrangler.
  5. POST the deployment (multipart: manifest + branch + _worker.bundle,
     where _worker.bundle is itself a multipart Worker-upload form).
  6. Poll the deployment until it succeeds or fails, then print the URL.

Usage:
  npm run build
  python3 scripts/pages-direct-upload.py [--project gods-eye-view] [--branch cyber-layer]

Requires: pip package `blake3`, and node_modules/.bin/esbuild (devDependency).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import mimetypes
import os
import subprocess
import sys
import time
import urllib.request
import uuid

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

CREDENTIAL = "custom.cloudflare"
ALLOWED_HOSTS = ("api.cloudflare.com",)
API = "https://api.cloudflare.com/client/v4"
ACCOUNT_ID = "f9ed887c50c448dcd30081d653c39d13"

# wrangler's own test vector for hashFile: hashFile("foobar", ext="png").
_HASH_VECTOR = ("foobar", "png", "2082190357cfd3617ccfe04f340c6247")
COMPATIBILITY_DATE = "2026-09-01"
UPLOAD_BUCKET_FILES = 40


def pages_hash(content: bytes, ext: str) -> str:
    import blake3 as _blake3

    return _blake3.blake3((base64.b64encode(content).decode() + ext).encode()).hexdigest()[:32]


def check_hash_vector() -> None:
    content, ext, expected = _HASH_VECTOR
    got = pages_hash(content.encode(), ext)
    if got != expected:
        raise SystemExit(f"hash vector mismatch: {got} != {expected} (aborting)")


class ApiError(Exception):
    pass


def api_request(method, path, body=None, headers=None, bearer=None):
    """Authenticated request to api.cloudflare.com.

    Uses the authd surrogate for the stored credential, or the short-lived
    upload JWT (Bearer) for the asset-upload endpoints — same as wrangler.
    """
    data = None
    req_headers = dict(headers or {})
    if body is not None and not isinstance(body, (bytes, bytearray)):
        data = json.dumps(body).encode()
        req_headers.setdefault("Content-Type", "application/json")
    elif isinstance(body, (bytes, bytearray)):
        data = body
    req = urllib.request.Request(API + path, data=data, method=method, headers=req_headers)
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    else:
        add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=ALLOWED_HOSTS)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return read_json_response(resp)
    except urllib.request.HTTPError as e:
        detail = e.read().decode(errors="replace")[:800]
        raise ApiError(f"{method} {path} -> HTTP {e.code}: {detail}")


def encode_multipart(fields):
    """fields: list of (name, value) | (name, filename, content_type, bytes)."""
    boundary = f"----formdata-{uuid.uuid4().hex}"
    buf = bytearray()
    for field in fields:
        buf += f"--{boundary}\r\n".encode()
        if len(field) == 2:
            name, value = field
            buf += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
            buf += str(value).encode()
        else:
            name, filename, ctype, content = field
            buf += (
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: {ctype}\r\n\r\n"
            ).encode()
            buf += content
        buf += b"\r\n"
    buf += f"--{boundary}--\r\n".encode()
    return bytes(buf), boundary


def collect_files(dist):
    entries = []  # (relpath, abspath, size)
    for root, _dirs, files in os.walk(dist):
        for name in files:
            abspath = os.path.join(root, name)
            rel = os.path.relpath(abspath, dist).replace(os.sep, "/")
            if rel in ("_worker.js", "_headers", "_redirects", "_routes.json"):
                continue  # wrangler IGNORE_LIST: consumed as config, not assets
            if rel.startswith("functions/"):
                continue
            entries.append((rel, abspath, os.path.getsize(abspath)))
    return sorted(entries)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default="gods-eye-view")
    ap.add_argument("--branch", default="cyber-layer")
    ap.add_argument("--dist", default="dist")
    ap.add_argument("--repo", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    args = ap.parse_args(argv)

    check_hash_vector()
    repo, dist = args.repo, os.path.join(args.repo, args.dist)
    if not os.path.isdir(dist):
        raise SystemExit(f"build output not found: {dist} (run `npm run build` first)")

    # 1. Bundle the Advanced-Mode worker.
    worker_src = os.path.join(repo, "_worker.js")
    bundled_worker = os.path.join(dist, "_worker.js")
    esbuild = os.path.join(repo, "node_modules", ".bin", "esbuild")
    print(f"bundling {worker_src} ...")
    r = subprocess.run(
        [esbuild, worker_src, "--bundle", "--format=esm", "--platform=neutral",
         f"--outfile={bundled_worker}"],
        capture_output=True, text=True, cwd=repo,
    )
    if r.returncode != 0:
        raise SystemExit(f"esbuild failed:\n{r.stderr}")
    with open(bundled_worker, "rb") as f:
        worker_js = f.read()
    print(f"  worker bundle: {len(worker_js)} bytes -> {bundled_worker}")

    # 2. Hash every asset.
    entries = collect_files(dist)
    manifest, by_hash = {}, {}
    for rel, abspath, _size in entries:
        with open(abspath, "rb") as f:
            content = f.read()
        ext = os.path.splitext(rel)[1][1:]  # without dot, like wrangler
        h = pages_hash(content, ext)
        manifest["/" + rel] = h
        if h not in by_hash:
            ctype = mimetypes.guess_type(rel)[0] or "application/octet-stream"
            by_hash[h] = (content, ctype)
    print(f"  {len(entries)} files, {len(by_hash)} unique hashes")

    # 3. Project (create if missing).
    try:
        proj = api_request("GET", f"/accounts/{ACCOUNT_ID}/pages/projects/{args.project}")
        print(f"project '{args.project}' exists (production branch: "
              f"{proj['result'].get('production_branch')})")
    except ApiError as e:
        if "8000007" not in str(e) and "not found" not in str(e).lower():
            raise
        print(f"creating Pages project '{args.project}' ...")
        proj = api_request("POST", f"/accounts/{ACCOUNT_ID}/pages/projects",
                           {"name": args.project, "production_branch": args.branch})
        print("  created.")

    # 4. Upload assets with the JWT flow.
    jwt = api_request("GET",
                      f"/accounts/{ACCOUNT_ID}/pages/projects/{args.project}/upload-token")["result"]["jwt"]
    hashes = list(by_hash)
    missing = api_request("POST", "/pages/assets/check-missing", {"hashes": hashes}, bearer=jwt)["result"]
    print(f"  {len(hashes) - len(missing)} already uploaded, {len(missing)} to upload")
    for i in range(0, len(missing), UPLOAD_BUCKET_FILES):
        bucket = missing[i:i + UPLOAD_BUCKET_FILES]
        payload = [
            {"key": h, "value": base64.b64encode(by_hash[h][0]).decode(),
             "metadata": {"contentType": by_hash[h][1]}, "base64": True}
            for h in bucket
        ]
        api_request("POST", "/pages/assets/upload", payload, bearer=jwt)
        print(f"  uploaded {min(i + UPLOAD_BUCKET_FILES, len(missing))}/{len(missing)}")
    api_request("POST", "/pages/assets/upsert-hashes", {"hashes": hashes}, bearer=jwt)

    # 5. _worker.bundle = inner Worker-upload multipart (metadata + script).
    inner_meta = json.dumps({"main_module": "_worker.js",
                             "compatibility_date": COMPATIBILITY_DATE})
    inner_body, inner_boundary = encode_multipart([
        ("metadata", inner_meta),
        ("_worker.js", "_worker.js", "application/javascript+module", worker_js),
    ])

    outer_body, outer_boundary = encode_multipart([
        ("manifest", json.dumps(manifest)),
        ("branch", args.branch),
        ("_worker.bundle", "_worker.bundle",
         f"multipart/form-data; boundary={inner_boundary}", inner_body),
    ])
    print("creating deployment ...")
    dep = api_request(
        "POST", f"/accounts/{ACCOUNT_ID}/pages/projects/{args.project}/deployments",
        outer_body, headers={"Content-Type": f"multipart/form-data; boundary={outer_boundary}"},
    )["result"]
    dep_id = dep["id"]
    print(f"  deployment id: {dep_id}")

    # 6. Poll until done.
    deadline = time.time() + 300
    while time.time() < deadline:
        d = api_request("GET",
                        f"/accounts/{ACCOUNT_ID}/pages/projects/{args.project}/deployments/{dep_id}")["result"]
        stage = (d.get("latest_stage") or {}).get("status")
        name = (d.get("latest_stage") or {}).get("name")
        if stage in ("success", "failure"):
            url = d.get("url")
            print(f"deployment {stage}: {url} (stage: {name})")
            if stage != "success":
                raise SystemExit("deployment failed")
            print(f"\nLIVE: {url}\nPROD: https://{args.project}.pages.dev")
            return 0
        time.sleep(5)
    raise SystemExit("timed out waiting for deployment")


if __name__ == "__main__":
    raise SystemExit(main())
