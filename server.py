#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import socket
import ssl
import threading
import time
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent
WORKSPACE = ROOT.parent
STATIC = ROOT / "static"
STATE_DIR = ROOT / "state"
STATE_PATH = STATE_DIR / "dashboard.json"
CREDENTIALS_PATH = WORKSPACE / "credentials" / "mqtt.json"
HOST = os.environ.get("MQTT_DASHBOARD_HOST", "127.0.0.1")
PORT = int(os.environ.get("MQTT_DASHBOARD_PORT", "8776"))
DEFAULT_STALE_AFTER = 300


state_lock = threading.Lock()
runtime = {
    "connected": False,
    "last_error": "",
    "started_at": time.time(),
    "recon_until": 0.0,
    "credentials_mtime": 0.0,
}
mqtt_client = None
stop_event = threading.Event()


def now_ms() -> int:
    return int(time.time() * 1000)


def default_state() -> dict:
    return {
        "settings": {"stale_after_seconds": DEFAULT_STALE_AFTER},
        "layout": [],
        "points": {},
    }


def load_state() -> dict:
    if not STATE_PATH.exists():
        return default_state()
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default_state()
    base = default_state()
    base.update({k: data.get(k, base[k]) for k in base})
    return base


def save_state(data: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(STATE_PATH)


dashboard_state = load_state()


def read_credentials() -> dict | None:
    if not CREDENTIALS_PATH.exists():
        runtime["last_error"] = f"Missing {CREDENTIALS_PATH}"
        return None
    try:
        return json.loads(CREDENTIALS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        runtime["last_error"] = f"Could not read MQTT credentials: {exc}"
        return None


def parse_broker_url(raw_url: str) -> tuple[str, int, bool]:
    parsed = urlparse(raw_url)
    scheme = parsed.scheme.lower()
    if scheme not in {"mqtt", "mqtts", "tcp", "ssl"}:
        raise ValueError("MQTT URL scheme must be mqtt, mqtts, tcp, or ssl")
    host = parsed.hostname
    if not host:
        raise ValueError("MQTT URL must include a host")
    tls = scheme in {"mqtts", "ssl"}
    default_port = 8883 if tls else 1883
    return host, parsed.port or default_port, tls


def parse_payload(payload: bytes):
    text = payload.decode("utf-8", errors="replace").strip()
    if not text:
        return "", None
    try:
        decoded = json.loads(text)
    except json.JSONDecodeError:
        return text, None
    return decoded, decoded


def display_value(payload: bytes) -> str:
    decoded, _ = parse_payload(payload)
    if isinstance(decoded, (str, int, float, bool)) or decoded is None:
        return str(decoded)
    return json.dumps(decoded, ensure_ascii=False, separators=(",", ":"))


def parse_datetime(value) -> int | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        seconds = value / 1000 if value > 10_000_000_000 else value
        return int(seconds * 1000)
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    variants = [raw]
    if raw.endswith("Z"):
        variants.append(raw[:-1] + "+00:00")
    for candidate in variants:
        try:
            parsed = datetime.fromisoformat(candidate)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=datetime.now().astimezone().tzinfo)
            return int(parsed.timestamp() * 1000)
        except ValueError:
            pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            parsed = datetime.strptime(raw, fmt).replace(tzinfo=datetime.now().astimezone().tzinfo)
            return int(parsed.timestamp() * 1000)
        except ValueError:
            pass
    return None


def source_timestamp(parsed) -> int | None:
    if not isinstance(parsed, dict):
        return None
    for key in ("timestamp", "time", "datetime", "date"):
        ts = parse_datetime(parsed.get(key))
        if ts:
            return ts
    return None


def initial_hidden(topic: str) -> bool:
    return topic.startswith("homeassistant/") or topic.endswith("/config")


def label_from_topic(topic: str) -> str:
    return topic.replace("/", " / ").replace("_", " ").replace("-", " ")


def group_from_topic(topic: str) -> str:
    parts = [part for part in topic.split("/") if part]
    return parts[0] if parts else "Ungrouped"


def scalar_fields(parsed) -> dict:
    if not isinstance(parsed, dict):
        return {}
    values = parsed.get("values") if isinstance(parsed.get("values"), dict) else parsed
    return {
        str(key): value
        for key, value in values.items()
        if isinstance(value, (str, int, float, bool)) or value is None
    }


def label_from_field(key: str) -> str:
    return key.replace("_", " ").replace("-", " ")


def upsert_point(topic: str, payload: bytes, retained: bool, qos: int) -> None:
    decoded, parsed = parse_payload(payload)
    source_ts = source_timestamp(parsed)
    fields = scalar_fields(parsed)
    with state_lock:
        point = dashboard_state["points"].setdefault(topic, {
            "topic": topic,
            "name": label_from_topic(topic),
            "group": group_from_topic(topic),
            "order": len(dashboard_state["layout"]),
            "hidden": initial_hidden(topic),
            "selected": False,
            "fields": {},
            "stale_after_seconds": None,
        })
        stored_fields = point.setdefault("fields", {})
        for key in fields:
            stored_fields.setdefault(key, {
                "name": label_from_field(key),
                "selected": False,
            })
        point.update({
            "value": str(decoded) if isinstance(decoded, (str, int, float, bool)) or decoded is None else json.dumps(decoded, ensure_ascii=False, separators=(",", ":")),
            "raw": payload.decode("utf-8", errors="replace"),
            "parsed": parsed if isinstance(parsed, (dict, list)) else None,
            "field_values": fields,
            "updated_at": now_ms(),
            "source_updated_at": source_ts,
            "retained": retained,
            "qos": qos,
        })
        if topic not in dashboard_state["layout"]:
            dashboard_state["layout"].append(topic)
        save_state(dashboard_state)


def point_payload() -> dict:
    with state_lock:
        data = json.loads(json.dumps(dashboard_state))
    stale_default = int(data.get("settings", {}).get("stale_after_seconds") or DEFAULT_STALE_AFTER)
    current = now_ms()
    ordered = []
    for topic in data.get("layout", []):
        point = data.get("points", {}).get(topic)
        if point:
            ordered.append(point)
    for topic, point in sorted(data.get("points", {}).items()):
        if topic not in data.get("layout", []):
            ordered.append(point)
    for point in ordered:
        stale_after = int(point.get("stale_after_seconds") or stale_default)
        updated_at = int(point.get("source_updated_at") or point.get("updated_at") or 0)
        point["received_age_seconds"] = round((current - int(point.get("updated_at") or 0)) / 1000) if point.get("updated_at") else None
        point["age_seconds"] = round((current - updated_at) / 1000) if updated_at else None
        point["stale"] = not updated_at or (current - updated_at) > stale_after * 1000
    return {
        "settings": data.get("settings", {}),
        "points": ordered,
        "runtime": {
            "connected": runtime["connected"],
            "last_error": runtime["last_error"],
            "has_credentials": CREDENTIALS_PATH.exists(),
            "has_mqtt_library": True,
            "recon_until": int(runtime["recon_until"] * 1000) if runtime["recon_until"] else 0,
        },
    }


def update_config(payload: dict) -> dict:
    with state_lock:
        if "settings" in payload and isinstance(payload["settings"], dict):
            dashboard_state["settings"].update({
                key: value for key, value in payload["settings"].items()
                if key in {"stale_after_seconds"}
            })
        if "layout" in payload and isinstance(payload["layout"], list):
            known = set(dashboard_state["points"])
            dashboard_state["layout"] = [topic for topic in payload["layout"] if topic in known]
        if "points" in payload and isinstance(payload["points"], dict):
            for topic, changes in payload["points"].items():
                if topic not in dashboard_state["points"] or not isinstance(changes, dict):
                    continue
                point = dashboard_state["points"][topic]
                for key in ("name", "group", "hidden", "selected", "stale_after_seconds", "transform"):
                    if key in changes:
                        point[key] = changes[key]
                if "fields" in changes and isinstance(changes["fields"], dict):
                    stored_fields = point.setdefault("fields", {})
                    for field_key, field_changes in changes["fields"].items():
                        if not isinstance(field_changes, dict):
                            continue
                        field = stored_fields.setdefault(field_key, {
                            "name": label_from_field(field_key),
                            "selected": False,
                        })
                        for key in ("name", "selected", "transform"):
                            if key in field_changes:
                                field[key] = field_changes[key]
        save_state(dashboard_state)
    return point_payload()


def mqtt_string(value: str) -> bytes:
    raw = value.encode("utf-8")
    return len(raw).to_bytes(2, "big") + raw


def mqtt_remaining_length(length: int) -> bytes:
    encoded = bytearray()
    while True:
        digit = length % 128
        length //= 128
        if length:
            digit |= 0x80
        encoded.append(digit)
        if not length:
            return bytes(encoded)


def mqtt_packet(packet_type: int, flags: int, payload: bytes) -> bytes:
    return bytes([(packet_type << 4) | flags]) + mqtt_remaining_length(len(payload)) + payload


def read_exact(sock: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = sock.recv(length - len(chunks))
        if not chunk:
            raise ConnectionError("MQTT socket closed")
        chunks.extend(chunk)
    return bytes(chunks)


def read_remaining_length(sock: socket.socket) -> int:
    multiplier = 1
    value = 0
    while True:
        digit = read_exact(sock, 1)[0]
        value += (digit & 127) * multiplier
        if (digit & 128) == 0:
            return value
        multiplier *= 128
        if multiplier > 128 * 128 * 128:
            raise ValueError("Malformed MQTT remaining length")


def send_connect(sock: socket.socket, creds: dict) -> None:
    flags = 0x02
    payload = mqtt_string(creds.get("client_id") or "openclaw-sensor-dashboard")
    username = creds.get("username") or ""
    password = creds.get("password") or ""
    if username:
        flags |= 0x80
        payload += mqtt_string(username)
    if password:
        flags |= 0x40
        payload += mqtt_string(password)
    variable = mqtt_string("MQTT") + bytes([4, flags]) + int(60).to_bytes(2, "big")
    sock.sendall(mqtt_packet(1, 0, variable + payload))
    header = read_exact(sock, 1)[0]
    if header >> 4 != 2:
        raise ConnectionError("MQTT broker did not send CONNACK")
    body = read_exact(sock, read_remaining_length(sock))
    if len(body) < 2 or body[1] != 0:
        raise ConnectionError(f"MQTT CONNACK refused connection: {body[1] if len(body) > 1 else 'unknown'}")


def send_subscribe(sock: socket.socket, topics: list[str]) -> None:
    payload = int(1).to_bytes(2, "big")
    for topic in topics:
        payload += mqtt_string(topic) + b"\x00"
    sock.sendall(mqtt_packet(8, 2, payload))


def handle_publish(first_byte: int, body: bytes) -> None:
    if len(body) < 2:
        return
    topic_len = int.from_bytes(body[:2], "big")
    topic_end = 2 + topic_len
    topic = body[2:topic_end].decode("utf-8", errors="replace")
    qos = (first_byte & 0x06) >> 1
    payload_start = topic_end + (2 if qos else 0)
    payload = body[payload_start:]
    upsert_point(topic, payload, bool(first_byte & 0x01), qos)


def mqtt_loop(creds: dict, stop: threading.Event) -> None:
    host, port, tls_from_url = parse_broker_url(creds.get("url", ""))
    topics = creds.get("topics") or ["#"]
    use_tls = bool(creds.get("tls") or tls_from_url)
    while not stop.is_set():
        try:
            raw_sock = socket.create_connection((host, port), timeout=15)
            sock = ssl.create_default_context().wrap_socket(raw_sock, server_hostname=host) if use_tls else raw_sock
            sock.settimeout(5)
            send_connect(sock, creds)
            send_subscribe(sock, topics)
            runtime["connected"] = True
            runtime["last_error"] = ""
            last_ping = time.time()
            while not stop.is_set():
                if time.time() - last_ping > 30:
                    sock.sendall(mqtt_packet(12, 0, b""))
                    last_ping = time.time()
                try:
                    first_byte = read_exact(sock, 1)[0]
                    body = read_exact(sock, read_remaining_length(sock))
                except socket.timeout:
                    continue
                packet_type = first_byte >> 4
                if packet_type == 3:
                    handle_publish(first_byte, body)
        except Exception as exc:
            runtime["connected"] = False
            runtime["last_error"] = f"MQTT connection error: {exc}"
            stop.wait(5)
        finally:
            try:
                sock.close()
            except Exception:
                pass


def start_mqtt() -> None:
    global mqtt_client
    creds = read_credentials()
    if not creds:
        return
    try:
        host, port, tls_from_url = parse_broker_url(creds.get("url", ""))
    except ValueError as exc:
        runtime["last_error"] = str(exc)
        return
    runtime["recon_until"] = time.time() + int(creds.get("recon_seconds") or 0)
    runtime["last_error"] = ""
    stop_event.clear()
    mqtt_client = threading.Thread(target=mqtt_loop, args=(creds, stop_event), daemon=True)
    mqtt_client.start()


def mqtt_watchdog() -> None:
    global mqtt_client
    while True:
        mtime = CREDENTIALS_PATH.stat().st_mtime if CREDENTIALS_PATH.exists() else 0.0
        if mtime and mtime != runtime["credentials_mtime"]:
            runtime["credentials_mtime"] = mtime
            if mqtt_client:
                stop_event.set()
                mqtt_client.join(timeout=8)
            start_mqtt()
        elif not mtime:
            runtime["connected"] = False
            runtime["last_error"] = f"Missing {CREDENTIALS_PATH}"
        time.sleep(5)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC), **kwargs)

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/points":
            self.send_json(200, point_payload())
            return
        if path in {"/settings", "/settings/", "/dashboard", "/dashboard/"}:
            self.path = "/"
        return super().do_GET()

    def do_HEAD(self):
        path = urlparse(self.path).path
        if path == "/api/points":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        if path in {"/settings", "/settings/", "/dashboard", "/dashboard/"}:
            self.path = "/"
        return super().do_HEAD()

    def do_POST(self):
        if urlparse(self.path).path != "/api/config":
            self.send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            self.send_json(400, {"error": "invalid json"})
            return
        self.send_json(200, update_config(payload))

    def do_DELETE(self):
        if urlparse(self.path).path != "/api/points":
            self.send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            self.send_json(400, {"error": "invalid json"})
            return
        topic = payload.get("topic")
        if not isinstance(topic, str) or not topic:
            self.send_json(400, {"error": "topic required"})
            return
        with state_lock:
            dashboard_state["points"].pop(topic, None)
            if topic in dashboard_state["layout"]:
                dashboard_state["layout"].remove(topic)
            save_state(dashboard_state)
        self.send_json(200, point_payload())


def main() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=mqtt_watchdog, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"MQTT sensor dashboard listening on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
