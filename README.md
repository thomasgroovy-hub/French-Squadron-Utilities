# French Squadron Utilities

Bot Discord Node.js utilisant `discord.js v14`, MySQL et une API Roblox.

## Commandes

### Général

- `/ping` : mesure le temps de réponse de la commande et les latences des API (`🏓Pong ! | Temps de réponse : Xms | API : Discord Xms, Roblox Xms`).

### Vérification Roblox

- `/verification-panel` : poste le panneau de vérification Roblox.
- `/panel-role` : poste le panneau des rôles de notifications.
- `/who-is discord:<membre>` : recherche une liaison à partir d'un membre Discord.
- `/who-is roblox:<pseudo>` : recherche une liaison à partir d'un pseudo Roblox.
- `/unlink utilisateur:<membre>` : supprime la liaison Roblox de la personne ciblée.

Le bouton de vérification utilise des `customId` fixes et persistants. Les codes de vérification expirent après 15 minutes.
Les appels vers l'API Roblox (recherche de pseudo et profils) disposent d'un cache en mémoire avec TTL de 5 minutes pour éviter tout rate-limit.

Le panneau de notifications attribue les rôles développement `1545976696312696873`, lore `1545976671369433218` et sessions `1545976696312696873`. Après une vérification réussie, le rôle temporaire `1545975768104968272` est retiré et le rôle vérifié est attribué.

Le rang interne est attribué automatiquement et n'est jamais réutilisé, même après un `/unlink`.

### Modération

- `/avertissement utilisateur:<membre> raison:<raison>` : enregistre un avertissement, envoie un DM et crée un log.
- `/exclusion utilisateur:<membre> raison:<raison> duree:<durée>` : applique une exclusion temporaire sur tous les serveurs où le bot est présent. Maximum : 28 jours.
- `/bannissement-global utilisateur:<membre> raison:<raison>` : envoie d'abord un DM puis bannit sur tous les serveurs où le bot est présent.
- `/fin-exclusion utilisateur:<membre> raison:<raison>` : retire l’exclusion temporaire d’un utilisateur.
- `/fin-bannissement utilisateur:<membre> raison:<raison>` : retire le bannissement d’un utilisateur.
- `/purgeavertissement utilisateur:<membre> raison:<raison>` : purger en totalité les avertissements d’une personne.
- `/purgecasier utilisateur:<membre> raison:<raison>` : purge entièrement le casier de modération enregistré d’une personne.
- `/retireravertissement utilisateur:<membre> avertissement:<id>` : retire un avertissement précis affiché dans le casier de modération.
- `/expulsion utilisateur:<membre> raison:<raison>` : expulse l’utilisateur de tous les serveurs où le bot est présent.

Les confirmations des sanctions dans les salons sont sobres et épurées. Les détails techniques du traitement multi-serveurs restent réservés au salon de logs staff.

### Présentation des messages

Les messages structurés utilisent les Discord Components V2 (`ContainerBuilder`, `TextDisplayBuilder`, `SectionBuilder` et `SeparatorBuilder`) avec un accent sombre cohérent. Les séparations sont natives Discord et les titres n’utilisent plus de préfixe décoratif.

## Permissions

Les permissions sont vérifiées sur la guilde de modération `1487258655840669807`. L'utilisateur doit posséder **exactement** le rôle requis (aucun héritage automatique de rôle supérieur) :

- Panel de vérification : rôle `1518410191933014057`.
- `/unlink` : rôle `1487276505712033883`.
- Modération (`/avertissement`, `/exclusion`, `/bannissement-global`, `/fin-exclusion`, `/fin-bannissement`, `/purgeavertissement`, `/purgecasier`, `/retireravertissement`, `/expulsion`) : rôle `1487266203864006707`.

Les commandes sont exécutables indifféremment depuis les guildes `1454217001626243288` et `1487258655840669807`.

## Logs & Événements Roblox

Les logs de vérification, unlink et modération sont envoyés dans le salon `1546193398388494336` de la guilde `1487258655840669807`.

Les bannissements enregistrent les noms exacts des serveurs concernés dans `moderation_bans`. Lors d’un débannissement, ces noms sont envoyés en message privé puis les entrées sont supprimées.

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

Le bot initialise automatiquement les tables MySQL `roblox_discord_links`, `roblox_pending_links`, `roblox_processed_death_events`, `strikes` et `moderation_cases`.
Il supporte également l'arrêt gracieux (*graceful shutdown*) sur signaux `SIGINT` et `SIGTERM`.
