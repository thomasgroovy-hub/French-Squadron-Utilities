# French Squadron Utilities

Bot Discord Node.js utilisant `discord.js v14`, MySQL et une API Roblox.

## Commandes

### Général

- `/ping` : mesure le temps de réponse de la commande et les latences des API (`🏓Pong ! | Temps de réponse : Xms | API : Discord Xms, Roblox Xms`).

### Vérification Roblox

- `/verification-panel` : poste le panneau de vérification Roblox.
- `/who-is discord:<membre>` : recherche une liaison à partir d'un membre Discord.
- `/who-is roblox:<pseudo>` : recherche une liaison à partir d'un pseudo Roblox.
- `/unlink utilisateur:<membre>` : supprime la liaison Roblox de la personne ciblée.

Le bouton de vérification utilise des `customId` fixes et persistants. Les codes de vérification expirent après 15 minutes.
Les appels vers l'API Roblox (recherche de pseudo et profils) disposent d'un cache en mémoire avec TTL de 5 minutes pour éviter tout rate-limit.

Le rang interne est attribué automatiquement et n'est jamais réutilisé, même après un `/unlink`.

### Modération

- `/strikes utilisateur:<membre> raison:<raison>` : enregistre un strike, envoie un DM et crée un log.
- `/timeout utilisateur:<membre> raison:<raison> duree:<durée>` : applique le timeout choisi sur tous les serveurs où le bot est présent. Formats acceptés : `m` (minutes), `h` (heures) et `d` (jours), par exemple `1h`. Maximum : 28 jours.
- `/globalban utilisateur:<membre> raison:<raison>` : envoie d'abord un DM puis bannit sur tous les serveurs où le bot est présent.
- `/untimeout utilisateur:<membre> raison:<raison>` : retire le timeout sur tous les serveurs où le membre est présent.
- `/unban utilisateur:<membre> raison:<raison>` : retire le bannissement sur tous les serveurs où le bot peut le faire.
- `/removestrike utilisateur:<membre> raison:<raison>` : supprime tous les strikes enregistrés pour la personne ciblée.

Les confirmations des sanctions dans les salons sont sobres et épurées. Les détails techniques du traitement multi-serveurs restent réservés au salon de logs staff.

### Présentation des Embeds

Tous les embeds adoptent une esthétique sombre et épurée (thème Discord `#2B2D31`), avec un séparateur fin `────────────────────────────────────────`, un titre préfixé par `◆` et le footer uniforme `FPCS Utilities` avec timestamp natif.

## Permissions

Les permissions sont vérifiées sur la guilde de modération `1487258655840669807`. L'utilisateur doit posséder **exactement** le rôle requis (aucun héritage automatique de rôle supérieur) :

- Panel de vérification : rôle `1518410191933014057`.
- `/unlink` : rôle `1487276505712033883`.
- Modération (`/strikes`, `/timeout`, `/globalban`, `/untimeout`, `/unban`, `/removestrike`) : rôle `1487266203864006707`.

Les commandes sont exécutables indifféremment depuis les guildes `1454217001626243288` et `1487258655840669807`.

## Logs & Événements Roblox

Les logs de vérification, unlink et modération sont envoyés dans le salon `1546193398388494336` de la guilde `1487258655840669807`.

Les événements de mort définitive (permadeath) en jeu utilisent la route :

```text
POST /v1/roblox/permadeath-death
```

Cette route est protégée par `ROBLOX_EVENT_SECRET` via un Bearer token et utilise un Cloudflare Quick Tunnel avec reconnexion automatique en cas de déconnexion.

## Variables d'environnement

- `DISCORD_TOKEN` : token du bot Discord (obligatoire).
- `DISCORD_APPLICATION_ID` : ID de l'application Discord (obligatoire).
- `MYSQL_HOST` : hôte MySQL (obligatoire).
- `MYSQL_PORT` : port MySQL (`3306` par défaut).
- `MYSQL_USER` : utilisateur MySQL (obligatoire).
- `MYSQL_PASSWORD` : mot de passe MySQL (obligatoire).
- `MYSQL_DATABASE` : nom de la base de données (obligatoire).
- `ROBLOX_EVENT_SECRET` : secret Bearer du webhook Roblox (obligatoire pour autoriser les requêtes Roblox).
- `PORT` : port HTTP local du webhook (`8080` par défaut).

## Installation et démarrage

```bash
npm install
npm start
```

Le bot initialise automatiquement les tables MySQL `roblox_discord_links`, `roblox_pending_links`, `roblox_processed_death_events` et `strikes`.
Il supporte également l'arrêt gracieux (*graceful shutdown*) sur signaux `SIGINT` et `SIGTERM`.
