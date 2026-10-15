"""Lance EchecBase dans sa propre fenêtre (ou dans le navigateur avec --browser)."""
import os
import sys

# Sans console (pythonw), stdout/stderr n'existent pas : on écrit dans data/echecbase.log.
if sys.stdout is None or sys.stderr is None:
    _here = os.path.dirname(sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__))
    os.makedirs(os.path.join(_here, "data"), exist_ok=True)
    _log = open(os.path.join(_here, "data", "echecbase.log"), "w", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = _log

import socket
import threading
import time
import traceback
import webbrowser

import uvicorn

from app.server import app

HOST = "127.0.0.1"


def free_port(preferred=8765):
    with socket.socket() as s:
        try:
            s.bind((HOST, preferred))
            return preferred
        except OSError:
            s.bind((HOST, 0))
            return s.getsockname()[1]


def main():
    port = free_port()
    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True)
    t.start()
    while not server.started:
        time.sleep(0.05)
    url = f"http://{HOST}:{port}/"

    # Au démarrage : récupère les nouvelles parties et termine les analyses en attente.
    if "--no-sync" not in sys.argv:
        from app import jobs
        jobs.start(do_import=True)

    if "--browser" in sys.argv:
        print(f"EchecBase : {url}  (Ctrl+C pour quitter)")
        webbrowser.open(url)
        try:
            while t.is_alive():
                time.sleep(0.5)
        except KeyboardInterrupt:
            pass
    else:
        import webview
        webview.create_window("EchecBase", url, width=1440, height=920, min_size=(1000, 680),
                              background_color="#0b0b0c")
        webview.start()
    server.should_exit = True
    t.join(timeout=5)


if __name__ == "__main__":
    main()
