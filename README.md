# EchecBase

Outil personnel pour étudier ses ouvertures : import des parties Chess.com, analyse Stockfish,
positions problématiques, répertoire guidé (Stockfish + explorateur Lichess) et entraînement.

## Installation

Stockfish n'est pas inclus dans le dépôt : télécharger la version Windows (x86-64) sur
[stockfishchess.org](https://stockfishchess.org/download/) et la décompresser à la racine, dans
`stockfish-windows-x86-64-universal/` (ou indiquer un autre chemin dans Réglages).

## Lancer

Double-clic sur **`Lancer EchecBase.bat`** : l'appli s'ouvre dans sa propre fenêtre et synchronise
automatiquement les nouvelles parties.

Autres options :

```
.venv\Scripts\python run.py --browser    # dans le navigateur au lieu d'une fenêtre
.venv\Scripts\python run.py --no-sync    # sans synchronisation au démarrage
```

## Profils

Bouton en bas à gauche : basculer entre plusieurs joueurs, créer, renommer, supprimer un profil.
**Exporter** crée `EchecBase-<profil>-<date>.zip` dans Téléchargements (parties, analyses, répertoire,
entraînement ; jamais le jeton Lichess). Sur un autre PC, **Importer un profil** (ou l'écran d'accueil
au premier lancement) le récupère tel quel, puis la synchro complète avec les parties récentes.

## Données

- `config.json` : réglages communs à la machine (Stockfish, profondeurs, seuils, jeton Lichess)
- `data/profiles.json` : profil actif
- `data/profiles/<profil>/profile.json` : nom, pseudo Chess.com et réglages d'import du profil
- `data/profiles/<profil>/echecbase.db` : base SQLite du profil (parties, analyses, répertoire, entraînement)

## Organisation

- `app/` : backend Python (FastAPI + python-chess)
  - `profiles.py` profils (bascule, export/import .zip) · `importer.py` import Chess.com · `jobs.py` analyse de fond · `engine.py` Stockfish
  - `stats.py` points faibles, ouvertures, écarts au répertoire · `repertoire.py` · `training.py` · `explorer.py`
- `static/` : interface (JS sans build, chessground + chess.js dans `static/vendor/`)
