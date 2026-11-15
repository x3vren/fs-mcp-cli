# fs-mcp-cli

CLI Node.js (ESM) ultra-léger et minimaliste pour connecter, gérer et piloter des serveurs **MCP (Model Context Protocol)** locaux avec les modèles de **France Student** (`ia.francestudent.org`).

## Fonctionnalités

- **Transports MCP complets** : `stdio`, `SSE` et `Streamable HTTP` sans dépendance externe.
- **Détection automatique** : scanne les serveurs MCP déjà configurés (Claude Desktop, Claude Code, Cursor, Windsurf, Gemini CLI, Antigravity, VS Code).
- **Pool & Cache disque** : connexions persistantes, déduplication, reconnexion automatique, pré-chauffage silencieux et cache des schémas (`~/.fs_mcp_cache.json`, TTL 24h).
- **Boucle ReAct via outils client** : exécution parallèle (`Promise.all`), confirmation interactive avant exécution, règles d'approbation (`/auto`), masquage des secrets et journalisation (`~/.fs_mcp_actions.log`).
- **Interface terminal** : streaming Markdown, spinner, complétion `Tab`, historique persistant, collage multi-lignes et mode non interactif (`-p`).

## Prérequis

- **Node.js >= 18**
- Un compte **France Student** (`ia.francestudent.org`)

## Installation

```bash
git clone <url-du-repo>
cd fs-mcp-cli
npm install
cp mcp.example.json mcp.json
```

Sous Windows, un double-clic sur `fs-mcp.cmd` installe les dépendances si besoin et lance le CLI.

## Utilisation

```bash
node src/index.js
```

Ou en mode non interactif :

```bash
node src/index.js -p "Liste les outils disponibles" --yes
```

Au premier lancement, connectez-vous avec votre email et mot de passe France Student (ou via `/login token` avec le cookie `next-auth.session-token`).

## Commandes

| Commande | Description |
|---|---|
| `/login [token]` | Connexion au compte France Student |
| `/model` | Changer de modèle/agent |
| `/history` / `/resume [n]` | Lister et reprendre une conversation |
| `/mcp list` | Lister les serveurs configurés et leur statut |
| `/mcp status` | Vérifier la latence (`ping`) des serveurs |
| `/mcp detect` | Détecter les serveurs MCP locaux |
| `/mcp import <serveur\|all>` | Importer un serveur détecté dans `mcp.json` |
| `/mcp add <nom> <cmd\|url>` | Ajouter un serveur à `mcp.json` |
| `/mcp remove <serveur>` | Retirer un serveur de `mcp.json` |
| `/mcp test <serveur>` | Tester la connexion et lister les outils |
| `/mcp tools <serveur> [outil]` | Afficher les outils et leurs paramètres |
| `/mcp call <serveur> <outil> [json]` | Appeler un outil manuellement |
| `/mcp resources <serveur>` | Lister les ressources MCP |
| `/mcp read <serveur> <uri>` | Lire une ressource MCP |
| `/mcp prompts <serveur>` | Lister les prompts MCP |
| `/mcp reload` | Recharger `mcp.json` et vider le cache |
| `/auto on\|off\|safe\|allow\|list` | Gérer l'approbation automatique des appels |
| `/log [n]` | Afficher les derniers appels d'outils |
| `/debug on\|off` | Activer/désactiver les logs réseau |
| `/clear` / `/exit` | Nouveau chat / Quitter proprement |

## Tests

```bash
npm test
```
