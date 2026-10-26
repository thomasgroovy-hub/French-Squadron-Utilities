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
- `/activity statut:<Aurafarm|Développement|Arrêter>` : déclare l'activité du membre (rôle `1545983245034852362` requis), reflétée sur la rich presence du bot quand il se trouve dans le salon vocal suivi.


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

## Statut vocal dynamique (rich presence)

Le bot met à jour sa propre rich presence (activité **Watching** avec l'image RPC) en fonction des membres humains présents dans le salon vocal `1561485674149060689` (configurable via `VOICE_ACTIVITY_CHANNEL_ID`). Les bots sont ignorés.

La phrase dynamique est placée dans le **nom** de l'activité (le statut visible est `Watching <phrase>`) : c'est la seule partie affichée dans la liste des membres, un `details` n'y serait pas visible.

- Un membre : `Watching Alice est en train d'aurafarm depuis 5 minutes` ou `Watching Alice est en train de développer`.
- Deux membres (même activité) : `Alice et Bob sont en train d'aurafarm depuis 5 minutes` (durée du dernier arrivé) ou `Alice et Bob sont en train de développer`.
- Trois membres ou plus : `Plusieurs personnes sont en train d'aurafarm` / `... de développer` (activité majoritaire).
- Activités mixtes ou inconnues : un repli neutre `… est en train de voc'` est affiché.
- Personne dans le salon : un placeholder tourne toutes les 5 minutes (`I love you`, `There might be a time where you wouldn't see me`, `Est-ce que des gens lisent ça ?`) pour laisser le bot au calme. `VOICE_ACTIVITY_DEFAULT_NAME` remplace ce placeholder par un texte fixe.

L'activité de chaque utilisateur est opt-in via `/activity`, réservé au rôle `1545983245034852362` (et aux administrateurs). L'API Discord n'expose pas ce que font les gens. Les dates d'entrée sont suivies par `voiceStateUpdate` ; après un redémarrage, l'appartenance au salon est reconstruite sans inventer d'horodatage historique (la durée n'est donc pas affichée jusqu'à la prochaine entrée). Les logs `[VoiceActivity]` indiquent chaque entrée/sortie et chaque présence publiée pour diagnostiquer.

La présence est envoyée via le paquet gateway `PresenceUpdate` brut (les assets RPC sont ignorés par `setActivity` de discord.js). L'image doit être téléversée dans les assets Rich Presence de l'application (Discord Developer Portal → Rich Presence → Art Assets) ; par défaut c'est `182D7D51-2F44-477A-8505-AC972CF2E8ED`, surchargeable via `VOICE_ACTIVITY_RPC_IMAGE` (si l'image n'apparaît pas, utiliser l'ID numérique de l'asset depuis le portail).

Le bot a besoin de l'intent `GuildVoiceStates` (déjà déclaré) et doit avoir accès au salon cible.

## Variables d'environnement

- `DISCORD_TOKEN` : token du bot Discord (obligatoire).
- `DISCORD_APPLICATION_ID` : ID de l'application Discord (obligatoire).
- `MYSQL_HOST` : hôte MySQL (obligatoire).
- `MYSQL_PORT` : port MySQL (`3306` par défaut).
- `MYSQL_USER` : utilisateur MySQL (obligatoire).
- `MYSQL_PASSWORD` : mot de passe MySQL (obligatoire).
- `MYSQL_DATABASE` : nom de la base de données (obligatoire).
- `VOICE_ACTIVITY_CHANNEL_ID` : salon vocal cible (défaut : `1561485674149060689`).
- `VOICE_ACTIVITY_DEFAULT_NAME` : placeholder fixe quand le salon est vide (remplace la rotation, optionnel).
- `VOICE_ACTIVITY_ROTATE_MS` : intervalle de rotation du placeholder (défaut : `300000`, soit 5 minutes).
- `VOICE_ACTIVITY_RPC_IMAGE` : asset image de la rich presence (défaut : `182D7D51-2F44-477A-8505-AC972CF2E8ED`).
- `VOICE_ACTIVITY_RPC_LARGE_TEXT` : infobulle de l'image RPC (optionnel).
- `VOICE_ACTIVITY_RPC_STATE` : seconde ligne de la rich presence (optionnel).
- `VOICE_ACTIVITY_REFRESH_MS` : fréquence de rafraîchissement de la durée affichée (défaut : `60000`).

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
