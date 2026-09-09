## Commandes (pour fire et cinnerk)

- `/verification-panel` : poste le panneau de vérification Roblox.
- `/panel-role` : poste le panneau des rôles de notifications.
- `/who-is discord:<membre>` : recherche une liaison à partir d'un membre Discord.
- `/who-is roblox:<pseudo>` : recherche une liaison à partir d'un pseudo Roblox.
- `/unlink utilisateur:<membre>` : supprime la liaison Roblox de la personne ciblée.
- `/ping` : bip boup boup génère le temps de réponse que le bot prends à répondre (+500 de MS = bot a un problème)
- `/avertissement utilisateur:<membre> raison:<raison>` : enregistre un avertissement, envoie un DM et crée un log.
- `/exclusion utilisateur:<membre> raison:<raison> duree:<durée>` : applique une exclusion temporaire sur tous les serveurs où le bot est présent. Maximum : 28 jours.
- `/bannissement-global utilisateur:<membre> raison:<raison>` : envoie d'abord un DM puis bannit sur tous les serveurs où le bot est présent.
- `/fin-exclusion utilisateur:<membre> raison:<raison>` : retire l’exclusion temporaire d’un utilisateur.
- `/fin-bannissement utilisateur:<membre> raison:<raison>` : retire le bannissement d’un utilisateur.
- `/purgeavertissement utilisateur:<membre> raison:<raison>` : purger en totalité les avertissements d’une personne.
- `/purgecasier utilisateur:<membre> raison:<raison>` : purge entièrement le casier de modération enregistré d’une personne.
- `/retireravertissement utilisateur:<membre> avertissement:<id>` : retire un avertissement précis affiché dans le casier de modération.
- `/expulsion utilisateur:<membre> raison:<raison>` : expulse l’utilisateur de tous les serveurs où le bot est présent.


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

Cette route est protégée par `ROBLOX_EVENT_SECRET` via un Bearer token.
Le bot écoute directement sur `PORT`; l’URL HTTPS publique doit être fournie par un relais séparé. `src/roblox.js` doit être déployé avec le bot Discord, pas dans le projet Railway du relais.

## Variables d'environnement

- `DISCORD_TOKEN` : token du bot Discord (obligatoire).
- `DISCORD_APPLICATION_ID` : ID de l'application Discord (obligatoire).
- `MYSQL_HOST` : hôte MySQL (obligatoire).
- `MYSQL_PORT` : port MySQL (`3306` par défaut).
- `MYSQL_USER` : utilisateur MySQL (obligatoire).
- `MYSQL_PASSWORD` : mot de passe MySQL (obligatoire).
- `MYSQL_DATABASE` : nom de la base de données (obligatoire).
- `ROBLOX_EVENT_SECRET` : secret Bearer du webhook Roblox (obligatoire pour autoriser les requêtes Roblox).
- `PORT` : port HTTP du bot (`8108` sur l’hébergement qui reçoit les requêtes du relais, `8080` par défaut).

## Installation et démarrage

```bash
npm install
npm start
```

Le bot initialise automatiquement les tables MySQL `roblox_discord_links`, `roblox_pending_links`, `roblox_processed_death_events`, `strikes` et `moderation_cases`.
Il supporte également l'arrêt gracieux (*graceful shutdown*) sur signaux `SIGINT` et `SIGTERM`.

### Configuration Roblox

1. Crée un secret Roblox Creator Hub nommé exactement comme `secretName` dans `PermadeathBotClient.Initiate`, par exemple `PERMADEATH_BOT_API_KEY`.
2. Donne à `ROBLOX_EVENT_SECRET` (ou `PERMADEATH_BOT_API_KEY`) la même valeur exacte côté bot. N’ajoute pas `Bearer` dans la valeur du secret : le module Roblox ajoute ce préfixe à l’en-tête HTTP.
3. Configure `url` dans le module Roblox avec l’URL HTTPS stable du relais, suivie de `/v1/roblox/permadeath-death`.
4. Sur Railway, déploie uniquement un proxy Bun/Worker qui écoute `process.env.PORT` et transfère vers `http://93.119.104.200:8108`; il doit recopier l’en-tête `Authorization`.
5. Vérifie que les requêtes HTTP sont autorisées dans Roblox Studio/Game Settings et que le jeu a été publié après la création du secret.

Le relais Railway ne doit pas exécuter `npm start` ni importer `src/roblox.js`. Pour un relais Bun, son fichier `index.tsx` doit contenir une fonction `Bun.serve({ fetch(request) { ... } })`; sinon `request` n’existe pas au démarrage et Railway redémarre en boucle.
