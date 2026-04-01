#!/usr/bin/env python3
import json
import struct
import subprocess
import sys
import time
from pathlib import Path

BOOKS_DIR = Path(__file__).parent.parent / "livros"
ACCESS_DURATION_MINUTES = 60
STATE_FILE = Path(__file__).parent / "state.json"

def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {"allowed_until": None, "current_session": None}

def save_state(state):
    STATE_FILE.write_text(json.dumps(state))

def send_message(message):
    encoded = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("@I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    message_length = struct.unpack("@I", raw_length)[0]
    data = sys.stdin.buffer.read(message_length).decode("utf-8")
    return json.loads(data)

def is_allowed(state):
    if state["allowed_until"] is None:
        return False, 0.0
    remaining = state["allowed_until"] - time.time()
    if remaining <= 0:
        state["allowed_until"] = None
        return False, 0.0
    return True, remaining / 60

def list_books():
    books = []
    if not BOOKS_DIR.exists():
        return books
    allowed_exts = {".epub", ".pdf"}
    files = sorted([p for p in BOOKS_DIR.iterdir() if p.is_file() and p.suffix.lower() in allowed_exts])
    for i, path in enumerate(files):
        books.append({"id": str(path), "title": path.stem, "format": path.suffix.lower().lstrip("."), "preselected": i == 0})
    return books

def handle_message(msg):
    state = load_state()
    action = msg.get("action")

    if action == "status":
        allowed, remaining = is_allowed(state)
        save_state(state)
        return {"ok": True, "allowed": allowed, "remaining_minutes": round(remaining, 1), "current_session": state["current_session"]}

    if action == "list_books":
        return {"ok": True, "books": list_books()}

    if action == "start_session":
        book_id = msg.get("book_id")
        mode = msg.get("mode")
        amount = msg.get("amount")
        if not book_id or mode not in {"chapter", "pages"}:
            return {"ok": False, "error": "Parâmetros inválidos"}
        state["allowed_until"] = None
        state["current_session"] = {"book_id": book_id, "mode": mode, "amount": amount}
        save_state(state)

        # Abre o livro com o programa padrão do sistema
        subprocess.Popen(["xdg-open", book_id])

        return {"ok": True}

    if action == "complete_session":
        if state["current_session"] is None:
            return {"ok": False, "error": "Nenhuma sessão ativa"}
        state["allowed_until"] = time.time() + ACCESS_DURATION_MINUTES * 60
        state["current_session"] = None
        save_state(state)
        return {"ok": True, "access_granted_minutes": ACCESS_DURATION_MINUTES}

    return {"ok": False, "error": f"Ação desconhecida: {action}"}

def main():
    while True:
        message = read_message()
        if message is None:
            break
        response = handle_message(message)
        send_message(response)

if __name__ == "__main__":
    main()