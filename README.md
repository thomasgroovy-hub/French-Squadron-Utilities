# French Squadron Utilities

Bot Discord Node.js utilisant `discord.js v14`, MySQL et une API Roblox.

## Commandes

### Vérification Roblox

- `/verification-panel` : poste le panneau de vérification Roblox.
- `/who-is discord:<membre>` : recherche une liaison à partir d'un membre Discord.
- `/who-is roblox:<pseudo>` : recherche une liaison à partir d'un pseudo Roblox.
- `/unlink utilisateur:<membre>` : supprime la liaison Roblox de la personne ciblée.

Le bouton de vérification utilise des `customId` fixes : il reste fonctionnel après un redémarrage du bot. Les codes de vérification expirent après 15 minutes.

Le rang interne est attribué automatiquement et n'est jamais réutilisé, même après un `/unlink`.

### Modération

- `/strikes utilisateur:<membre> raison:<raison>` : enregistre un strike, envoie un DM et crée un log.
- `/timeout utilisateur:<membre> raison:<raison> duree:<durée>` : applique le timeout choisi sur tous les serveurs où le bot est présent. Formats acceptés : `m` (minutes), `h` (heures) et `d` (jours), par exemple `1h`. Maximum : 28 jours.
- `/globalban utilisateur:<membre> raison:<raison>` : envoie d'abord un DM puis bannit sur tous les serveurs où le bot est présent.
- `/untimeout utilisateur:<membre> raison:<raison>` : retire le timeout sur tous les serveurs où le membre est présent.
- `/unban utilisateur:<membre> raison:<raison>` : retire le bannissement sur tous les serveurs où le bot peut le faire.
- `/removestrike utilisateur:<membre> raison:<raison>` : supprime tous les strikes enregistrés pour la personne ciblée.

Les confirmations de `/strikes`, `/timeout` et `/globalban` sont publiques dans le salon où la commande est exécutée. Elles sont également envoyées dans le salon de logs. Les détails techniques du traitement multi-serveurs restent réservés aux logs.

Les sanctions utilisent des embeds sobres et cohérents, sans emoji, avec le footer `FPCS Utilities` et un timestamp Discord natif :

- Strike : ambre `#D99A2B`.
- Timeout : bleu-gris `#607D8B`.
- Ban global : rouge sobre `#B34747`.

Les DMs de strike, timeout et ban sont aussi envoyés en embeds. Ils contiennent le modérateur, la raison et, pour un timeout, la durée. Les actions `/untimeout`, `/unban` et `/removestrike` utilisent la même présentation et sont journalisées.

Les commandes de modération gèrent chaque serveur séparément : une erreur sur un serveur n'empêche pas l'action sur les autres.

## Permissions

Les permissions sont vérifiées dans la guilde `1487258655840669807`. Un rôle placé plus haut dans la hiérarchie que le rôle de référence dispose également de l'accès.

- Panel de vérification : rôle `1518410191933014057` ou supérieur.
- `/unlink` : rôle `1487276505712033883` ou supérieur.
- Modération (`/strikes`, `/timeout`, `/globalban`) : rôle `1487266203864006707` ou supérieur.

Les commandes sont enregistrées sur les guildes `1454217001626243288` et `1487258655840669807`.

## Logs

Les logs de vérification, unlink et modération sont envoyés dans le salon `1546193398388494336` de la guilde `1487258655840669807`.

Les événements Roblox utilisent également la route :

```text
POST /v1/roblox/permadeath-death
```

Cette route est protégée par `ROBLOX_EVENT_SECRET` et conserve son tunnel Cloudflare Quick Tunnel.

## Variables d'environnement

Variables obligatoires :

- `DISCORD_TOKEN` : token du bot Discord.
- `DISCORD_APPLICATION_ID` : ID de l'application Discord.
- `MYSQL_HOST` : hôte MySQL.
- `MYSQL_PORT` : port MySQL, `3306` par défaut.
- `MYSQL_USER` : utilisateur MySQL.
- `MYSQL_PASSWORD` : mot de passe MySQL.
- `MYSQL_DATABASE` : base MySQL.
- `ROBLOX_EVENT_SECRET` : secret Bearer du webhook Roblox.
- `PORT` : port HTTP local du webhook, `8080` par défaut.

Aucune nouvelle variable d'environnement n'a été ajoutée pour la vérification ou la modération. Les IDs de guildes, rôles et salon de logs sont définis dans le code.

## Installation et démarrage

```bash
npm install
npm start
```

Le bot initialise automatiquement les tables MySQL `roblox_discord_links`, `roblox_pending_links`, `roblox_processed_death_events` et `strikes`.

## Nettoyage effectué

Les anciennes commandes Google Sheets/bloodline ont été supprimées, notamment `/sheet` et `/bloodline-add`, ainsi que leur code associé et la dépendance `googleapis`.
