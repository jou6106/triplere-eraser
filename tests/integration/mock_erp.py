"""Minimal stand-in for the Triple Re ERP upload API (POST /api/erasure/upload).

Same contract as ErasureUploadController: Bearer token, multipart fields log_file,
inventory_file, pdf_files[], client_name, technician_name, work_order; answers
{"ok":true,...} (201) or 401 / 422. Every request is recorded in <record>.jsonl.

    python3 mock_erp.py <port> <token> <record-file>
"""

import email
import email.policy
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT, TOKEN, RECORD = int(sys.argv[1]), sys.argv[2], sys.argv[3]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj, separators=(",", ":")).encode()  # compact, like Laravel
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        entry = {"path": self.path, "auth": self.headers.get("Authorization", ""), "fields": {}, "files": []}
        if self.headers.get("Authorization") != f"Bearer {TOKEN}":
            entry["status"] = 401
            self.record(entry)
            return self.reply(401, {"ok": False, "error": "invalid_token"})
        msg = email.message_from_bytes(
            b"Content-Type: " + self.headers["Content-Type"].encode() + b"\r\n\r\n" + raw, policy=email.policy.HTTP)
        for part in msg.iter_parts():
            name = part.get_param("name", header="content-disposition")
            filename = part.get_filename()
            payload = part.get_payload(decode=True) or b""
            if filename:
                entry["files"].append({"field": name, "filename": filename, "size": len(payload),
                                       "head": payload[:2000].decode("latin-1")})
            else:
                entry["fields"][name] = payload.decode("utf-8", "replace")
        entry["status"] = 201
        self.record(entry)
        self.reply(201, {"ok": True, "created": [{"report_number": "ER-TEST-1"}], "skipped": []})

    def record(self, entry):
        with open(RECORD, "a") as f:
            f.write(json.dumps(entry) + "\n")


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
