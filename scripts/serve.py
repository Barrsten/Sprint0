"""Static viewer + model HTTP service; no conversion runs in this process."""

from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
import argparse, json, os
from urllib.parse import urlsplit, unquote
from datetime import datetime, timezone


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".glb": "model/gltf-binary",
        ".wasm": "application/wasm",
        ".json": "application/json",
    }

    def translate_path(self, path: str) -> str:
        url = unquote(urlsplit(path).path)
        if url.startswith("/models/"):
            base = self.server.models
            relative = url[len("/models/") :]
        else:
            base = self.server.viewer
            relative = url.lstrip("/") or "index.html"
        resolved = (base / relative).resolve()
        if not resolved.is_relative_to(base):
            return str(base / "__forbidden__")
        return str(resolved)

    def end_headers(self):
        self.send_header(
            "Cache-Control",
            (
                "no-store"
                if "cold" in urlsplit(self.path).query
                else "public, max-age=3600"
            ),
        )
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_POST(self):
        if urlsplit(self.path).path != "/__reports":
            self.send_error(404)
            return
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            self.send_error(403)
            return
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= 10_000_000:
            self.send_error(413)
            return
        try:
            value = json.loads(self.rfile.read(size))
            if not isinstance(value, dict) or value.get("schemaVersion") != 1:
                raise ValueError("Invalid report")
            folder = self.server.reports
            folder.mkdir(parents=True, exist_ok=True)
            filename = datetime.now(timezone.utc).strftime(
                "benchmark-%Y%m%d-%H%M%S.json"
            )
            (folder / filename).write_text(
                json.dumps(value, ensure_ascii=False, indent=2)
            )
        except (ValueError, OSError) as exc:
            self.send_error(400, str(exc))
            return
        self.send_response(201)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"saved":true}')


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--models", type=Path, default=Path("reports"))
    a = p.parse_args()
    server = ThreadingHTTPServer((a.host, a.port), Handler)
    server.models = a.models.resolve()
    server.viewer = Path("viewer/dist").resolve()
    server.reports = Path("reports/browser").resolve()
    print(f"http://{a.host}:{a.port}/?model=/models/km/model.glb", flush=True)
    server.serve_forever()
