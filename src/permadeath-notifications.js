import { Events } from 'discord.js';
import { createPermadeathNotificationEmbed } from './components.js';
import { createDatabasePool } from './database.js';

export const PERMADEATH_CHANNEL_ID = '1546138245363007518';
export const PERMADEATH_DEATHS_TABLE = 'permadeath_deaths';

const MAX_CONTEXT_LENGTH = 500;

export function extractRobloxUsername(content) {
  const firstLine = String(content ?? '').split(/\r?\n/)[0].trim();
  return firstLine || null;
}

/**
 * Everything after the first line is free-form context: the reason, the map,
 * whatever the game relay writes. Kept separate from the username so the
 * companion site can display it without re-parsing the raw message.
 */
export function extractDeathContext(content) {
  const context = String(content ?? '').split(/\r?\n/).slice(1).join('\n').trim();
  return context ? context.slice(0, MAX_CONTEXT_LENGTH) : null;
}

function log(level, message, details = undefined) {
  console[level](`[Permadeath] ${message}`, ...(details === undefined ? [] : [details]));
}

/**
 * Per-pool table state, keyed weakly so it cannot outlive the pool itself.
 * Keying per pool (rather than in a module-level flag) also keeps each pool's
 * first call responsible for its own DDL.
 */
const deathsTableState = new WeakMap();

/**
 * Lazily creates the death log, mirroring the moderation tables pattern.
 *
 * The companion site declares the very same table with `CREATE TABLE IF NOT
 * EXISTS` on its read path, so whoever boots first wins and the other DDL is
 * a no-op. This definition is a strict superset of the site's: every column
 * the site reads (`discord_user_id`, `roblox_user_id`, `event_id`, `context`,
 * `occurred_at`) keeps the exact same name and type, and `roblox_username`
 * plus the unique `event_id` are additions.
 */
export async function ensurePermadeathDeathsTable(pool) {
  if (!pool || typeof pool.query !== 'function') return false;

  let state = deathsTableState.get(pool);
  if (!state) {
    state = { ready: false, initialization: null };
    deathsTableState.set(pool, state);
  }
  if (state.ready) return true;
  if (state.initialization) return state.initialization;

  state.initialization = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${PERMADEATH_DEATHS_TABLE} (
          id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          discord_user_id VARCHAR(20) NOT NULL,
          roblox_user_id VARCHAR(20) NOT NULL,
          roblox_username VARCHAR(64) NULL,
          event_id VARCHAR(64) NULL,
          context TEXT NULL,
          occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY permadeath_deaths_event_uidx (event_id),
          INDEX permadeath_deaths_discord_idx (discord_user_id),
          INDEX permadeath_deaths_roblox_idx (roblox_user_id),
          INDEX permadeath_deaths_occurred_idx (occurred_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      state.ready = true;
      return true;
    } catch (error) {
      log('error', `Création de ${PERMADEATH_DEATHS_TABLE} impossible:`, error.message);
      return false;
    } finally {
      state.initialization = null;
    }
  })();

  return state.initialization;
}

/**
 * Appends one death event. Never throws: the DM notification and the death log
 * are independent, and neither may take the other down. The Discord message id
 * is the stable event key, so a redelivered message cannot create a second
 * row (the unique key makes the insert idempotent when it exists).
 */
export async function recordPermadeathDeath({
  pool,
  discordUserId,
  robloxUserId,
  robloxUsername = null,
  eventId = null,
  context = null,
  occurredAt = new Date(),
} = {}) {
  if (!pool || !discordUserId || !robloxUserId) return false;

  try {
    if (!(await ensurePermadeathDeathsTable(pool))) return false;
    await pool.execute(
      `INSERT INTO ${PERMADEATH_DEATHS_TABLE}
         (discord_user_id, roblox_user_id, roblox_username, event_id, context, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE event_id = event_id`,
      [
        discordUserId,
        String(robloxUserId),
        robloxUsername,
        eventId,
        context,
        occurredAt,
      ],
    );
    return true;
  } catch (error) {
    log('error', `Enregistrement du décès en BDD impossible pour ${discordUserId}:`, error.message);
    return false;
  }
}

export function createPermadeathNotificationIntegration({ client, pool = createDatabasePool() }) {
  const processedMessageIds = new Set();

  async function handleMessage(message) {
    if (message.channelId !== PERMADEATH_CHANNEL_ID) return;
    if (processedMessageIds.has(message.id)) {
      log('warn', `Message déjà traité: ${message.id}`);
      return;
    }
    processedMessageIds.add(message.id);

    const robloxUsername = extractRobloxUsername(message.content);
    if (!robloxUsername) {
      log('warn', `Première ligne vide dans le message ${message.id}.`);
      return;
    }
    log('info', `Username Roblox détecté: ${robloxUsername}`);
    if (!pool) {
      log('error', 'La connexion BDD est indisponible.');
      return;
    }

    let link;
    try {
      log('info', 'Recherche BDD en cours...');
      const [rows] = await pool.execute(
        'SELECT discord_user_id, roblox_user_id, roblox_username FROM roblox_discord_links WHERE LOWER(roblox_username) = LOWER(?) LIMIT 1',
        [robloxUsername],
      );
      link = rows[0] ?? null;
    } catch (error) {
      log('error', `Erreur BDD pour ${robloxUsername}:`, error.message);
      return;
    }
    if (!link?.discord_user_id) {
      log('warn', `Aucune liaison Roblox/Discord trouvée pour: ${robloxUsername}`);
      return;
    }

    const discordUserId = link.discord_user_id;
    if (typeof discordUserId !== 'string' || !/^\d{17,20}$/.test(discordUserId)) {
      log('error', `Discord User ID invalide pour ${robloxUsername}: ${discordUserId}`);
      return;
    }

    let user;
    try {
      user = await client.users.fetch(discordUserId);
      log('info', `Utilisateur Discord trouvé: ${discordUserId}`);
    } catch (error) {
      log('error', `Utilisateur Discord introuvable (${discordUserId}):`, error.message);
      return;
    }
    if (!user?.send) {
      log('error', `Utilisateur Discord non envoyable (${discordUserId}).`);
      return;
    }

    let dmDelivered = false;
    try {
      await user.send({ embeds: [createPermadeathNotificationEmbed()] });
      dmDelivered = true;
      log('info', 'DM envoyé avec succès');
    } catch (error) {
      log('error', `DM PK impossible pour ${discordUserId}:`, error.message);
    }

    const recorded = await recordPermadeathDeath({
      pool,
      discordUserId,
      robloxUserId: link.roblox_user_id,
      robloxUsername: link.roblox_username || robloxUsername,
      eventId: message.id,
      context: extractDeathContext(message.content),
      occurredAt: message.createdAt instanceof Date ? message.createdAt : new Date(),
    });
    if (recorded) {
      log('info', `Décès enregistré pour ${discordUserId} (${link.roblox_username || robloxUsername})`);
    }

    if (!dmDelivered) return;

    for (const guild of client.guilds.cache.values()) {
      try {
        const voiceState = guild.voiceStates.cache.get(discordUserId);
        if (!voiceState?.channelId) continue;
        await voiceState.disconnect('Notification de mort envoyée');
        log('info', `Utilisateur déconnecté du vocal dans ${guild.id}`);
      } catch (error) {
        log('error', `Déconnexion vocale impossible pour ${discordUserId} dans ${guild.id}:`, error.message);
      }
    }
  }

  function start() {
    client.on(Events.MessageCreate, (message) => {
      void handleMessage(message).catch((error) => {
        log('error', `Erreur inattendue pour le message ${message.id}:`, error.message);
      });
    });
  }

  return { handleMessage, start, processedMessageIds };
}
