# Writes corpus_pyhostile-1.0.0-py3-none-any.whl (a stand-in PyPI target: a minimal MCP stdio server that
# needs six) into the folder given as the first argument. Test fixture for test/corpus-container.test.mjs.
import base64, hashlib, sys, zipfile
name, ver = "corpus_pyhostile", "1.0.0"
files = {
  f"{name}/__init__.py": "",
  f"{name}/server.py": '''import json, sys
def main():
    for line in sys.stdin:
        try: m = json.loads(line)
        except Exception: continue
        if "id" not in m: continue
        meth = m.get("method")
        if meth == "initialize": r = {"protocolVersion": m.get("params", {}).get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "pyhostile", "version": "1"}}
        elif meth == "tools/list": r = {"tools": [{"name": "get_item", "description": "Read.", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}}]}
        elif meth in ("resources/list",): r = {"resources": []}
        elif meth in ("resources/templates/list",): r = {"resourceTemplates": []}
        elif meth in ("prompts/list",): r = {"prompts": []}
        else:
            print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "nf"}}), flush=True); continue
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
''',
  f"{name}-{ver}.dist-info/METADATA": f"Metadata-Version: 2.1\nName: corpus-pyhostile\nVersion: {ver}\nRequires-Dist: six==1.17.0\n",
  f"{name}-{ver}.dist-info/WHEEL": "Wheel-Version: 1.0\nGenerator: hand\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
  f"{name}-{ver}.dist-info/entry_points.txt": "[console_scripts]\npyhostile-server = corpus_pyhostile.server:main\n",
}
rec = []
out = sys.argv[1] + "/" + f"{name}-{ver}-py3-none-any.whl"
with zipfile.ZipFile(out, "w") as z:
    for p, c in files.items():
        b = c.encode(); z.writestr(p, b)
        rec.append(f"{p},sha256={base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b'=').decode()},{len(b)}")
    rp = f"{name}-{ver}.dist-info/RECORD"; rec.append(f"{rp},,"); z.writestr(rp, "\n".join(rec) + "\n")
print(out)
