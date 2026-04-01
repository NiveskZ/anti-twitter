#!/usr/bin/env python3
"""
Native messaging host para a extensão Anti-Twitter.
Gerencia sessões de leitura e libera acesso ao X/Twitter por tempo limitado.

Configuração:
  ACCESS_DURATION_MINUTES = tempo de acesso liberado após completar a meta
  BOOKS_DIR = pasta onde ficam os livros (.epub e .pdf)
"""

import json
import struct
import sys
import time
from pathlib import Path

# ---- Configurações
# Pasta dos livros: por padrão usa 'livros/' dentro do projeto.
# Mude para outro caminho se preferir, ex: Path.home() / "Meus Livros"
BOOKS_DIR = Path(__file__).parent.parent / "livros"

ACCESS_DURATION_MINUTES = 60

STATE = {
    "allowed_until": None,   # timestamp unix até quando o acesso está liberado
    "current_session": None, # sessão de leitura ativa
}


def send_message(message: dict) -> None:
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


def is_allowed() -> tuple[bool, float]:
    """Retorna (está liberado, minutos restantes)."""
    if STATE["allowed_until"] is None:
        return False, 0.0
    remaining = STATE["allowed_until"] - time.time()
    if remaining <= 0:
        STATE["allowed_until"] = None  # expirou
        return False, 0.0
    return True, remaining / 60


def list_books() -> list:
    books = []
    if not BOOKS_DIR.exists():
        return books

    allowed_exts = {".epub", ".pdf"}
    files = sorted([
        p for p in BOOKS_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in allowed_exts
    ])

    for i, path in enumerate(files):
        books.append({
            "id": str(path),
            "title": path.stem,
            "format": path.suffix.lower().lstrip("."),
            "preselected": i == 0,
        })
    return books


def handle_message(msg: dict) -> dict:
    action = msg.get("action")

    # Retorna status atual de acesso
    if action == "status":
        allowed, remaining = is_allowed()
        return {
            "ok": True,
            "allowed": allowed,
            "remaining_minutes": round(remaining, 1),
            "current_session": STATE["current_session"],
        }

    # Lista livros disponíveis em ~/Livros
    if action == "list_books":
        return {"ok": True, "books": list_books()}

    # Inicia uma sessão de leitura (bloqueia o acesso)
    if action == "start_session":
        book_id = msg.get("book_id")
        mode = msg.get("mode")
        amount = msg.get("amount")

        if not book_id or mode not in {"chapter", "pages"}:
            return {"ok": False, "error": "Parâmetros inválidos"}

        STATE["allowed_until"] = None  # bloqueia enquanto lê
        STATE["current_session"] = {
            "book_id": book_id,
            "mode": mode,
            "amount": amount,
        }
        return {"ok": True}

    # Marca a meta como concluída e libera acesso por ACCESS_DURATION_MINUTES
    if action == "complete_session":
        if STATE["current_session"] is None:
            return {"ok": False, "error": "Nenhuma sessão ativa"}

        STATE["allowed_until"] = time.time() + ACCESS_DURATION_MINUTES * 60
        STATE["current_session"] = None
        return {
            "ok": True,
            "access_granted_minutes": ACCESS_DURATION_MINUTES,
        }

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
