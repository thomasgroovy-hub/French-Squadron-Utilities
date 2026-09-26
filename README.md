## Commandes

- `/ping` : bip boup boup génère le temps de réponse que le bot prends à répondre (+500 de MS = bot a un problème)
- `/verification-panel` : poste le panneau de vérification Roblox.
- `/who-is discord:<membre> roblox:<pseudo>` : recherche une liaison Discord ou Roblox.
- `/unlink utilisateur:<membre>` : supprime la liaison Roblox de l’utilisateur ciblé.
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

- Modération (`/avertissement`, `/exclusion`, `/bannissement-global`, `/fin-exclusion`, `/fin-bannissement`, `/purgeavertissement`, `/purgecasier`, `/retireravertissement`, `/expulsion`) : rôle `1487266203864006707`.

Les commandes sont exécutables indifféremment depuis les guildes `1454217001626243288` et `1487258655840669807`.

## Logs & Notifications PK

Les logs de vérification, unlink et modération sont envoyés dans le salon `1546193398388494336` de la guilde `1487258655840669807`.

Les messages du salon `1546138245363007518` sont surveillés pour notifier par DM les morts permanentes. Cette intégration utilise la table existante `roblox_discord_links`, effectue une recherche insensible à la casse et ne traite chaque message qu'une fois par identifiant Discord.

Les bannissements enregistrent les noms exacts des serveurs concernés dans `moderation_bans`. Lors d’un débannissement, ces noms sont envoyés en message privé puis les entrées sont supprimées.

## Variables d'environnement

- `DISCORD_TOKEN` : token du bot Discord (obligatoire).
- `DISCORD_APPLICATION_ID` : ID de l'application Discord (obligatoire).
- `MYSQL_HOST` : hôte MySQL (obligatoire).
- `MYSQL_PORT` : port MySQL (`3306` par défaut).
- `MYSQL_USER` : utilisateur MySQL (obligatoire).
- `MYSQL_PASSWORD` : mot de passe MySQL (obligatoire).
- `MYSQL_DATABASE` : nom de la base de données (obligatoire).

## Installation et démarrage

```bash
npm install
npm start
```

La notification PK lit la table MySQL existante `roblox_discord_links` et ne crée ni ne modifie de table Roblox.
Il supporte également l'arrêt gracieux (*graceful shutdown*) sur signaux `SIGINT` et `SIGTERM`.

## Tests

```bash
npm test
```

Les tests tournent sans accès réseau ni base de données. Le portail web vit dans le dépôt `French-Squadron-Web`.
