import { Events } from 'discord.js';
import { createPermadeathNotificationEmbed } from './components.js';
import { createDatabasePool } from './database.js';

export const PERMADEATH_CHANNEL_ID = '1546138245363007518';

export function extractRobloxUsername(content) {
  const firstLine = String(content ?? '').split(/\r?\n/)[0].trim();
  return firstLine || null;
}

function log(level, message, details = undefined) {
  console[level](`[Permadeath] ${message}`, ...(details === undefined ? [] : [details]));
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

    let discordUserId;
    try {
      log('info', 'Recherche BDD en cours...');
      const [rows] = await pool.execute(
        'SELECT discord_user_id FROM roblox_discord_links WHERE LOWER(roblox_username) = LOWER(?) LIMIT 1',
        [robloxUsername],
      );
      discordUserId = rows[0]?.discord_user_id;
    } catch (error) {
      log('error', `Erreur BDD pour ${robloxUsername}:`, error.message);
      return;
    }
    if (!discordUserId) {
      log('warn', `Aucune liaison Roblox/Discord trouvée pour: ${robloxUsername}`);
      return;
    }
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

    try {
      await user.send({ embeds: [createPermadeathNotificationEmbed()] });
      log('info', 'DM envoyé avec succès');
    } catch (error) {
      log('error', `DM PK impossible pour ${discordUserId}:`, error.message);
      return;
    }

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