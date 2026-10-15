"""Construit l'exécutable Windows autonome (dossier + zip) avec PyInstaller.

Usage (dans un environnement où requirements.txt et pyinstaller sont installés) :
    python build_exe.py [version]

Résultat : dist/EchecBase/ (EchecBase.exe + Stockfish) et dist/EchecBase-<version>-windows.zip.
Seuls les fichiers suivis par git sont embarqués : rien de local (données, modules non publiés).
"""
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")
APP_DIR = os.path.join(DIST, "EchecBase")
SF_DIR = os.path.join("stockfish-windows-x86-64-universal", "stockfish")
SF_FILES = ("stockfish-windows-x86-64-universal.exe", "Copying.txt", "AUTHORS", "README.md")
SF_NOTE = """Stockfish (https://stockfishchess.org) est distribué sous licence GPL v3 (voir Copying.txt).
Code source : https://github.com/official-stockfish/Stockfish
"""


def tracked(prefix):
    out = subprocess.run(["git", "ls-files", prefix], cwd=ROOT, capture_output=True, text=True, check=True)
    return out.stdout.split()


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else "dev"
    shutil.rmtree(DIST, ignore_errors=True)
    with tempfile.TemporaryDirectory() as tmp:
        # Interface : uniquement les fichiers publiés
        static = os.path.join(tmp, "static")
        for f in tracked("static"):
            dst = os.path.join(tmp, f)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(os.path.join(ROOT, f), dst)
        subprocess.run([
            sys.executable, "-m", "PyInstaller", "run.py",
            "--name", "EchecBase", "--windowed", "--noconfirm", "--clean",
            "--distpath", DIST, "--workpath", os.path.join(tmp, "build"), "--specpath", tmp,
            "--add-data", f"{static}{os.pathsep}static",
            "--exclude-module", "app.courses",
        ], cwd=ROOT, check=True)

    # Stockfish à côté de l'exe, au chemin attendu par défaut dans les réglages
    sf_dst = os.path.join(APP_DIR, SF_DIR)
    os.makedirs(sf_dst)
    for f in SF_FILES:
        shutil.copy2(os.path.join(ROOT, SF_DIR, f), sf_dst)
    with open(os.path.join(sf_dst, "LISEZMOI-Stockfish.txt"), "w", encoding="utf-8") as f:
        f.write(SF_NOTE)

    zpath = os.path.join(DIST, f"EchecBase-{version}-windows.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(APP_DIR):
            for f in files:
                p = os.path.join(base, f)
                z.write(p, os.path.relpath(p, DIST))
    print(f"OK : {zpath} ({os.path.getsize(zpath) / 1e6:.0f} Mo)")


if __name__ == "__main__":
    main()
