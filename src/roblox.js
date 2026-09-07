import express from 'express';
import mysql from 'mysql2/promise';
import { randomInt, timingSafeEqual } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { Tunnel } from 'cloudflared';

const ROBLOX_USERNAME_LOOKUP_URL = 'https://users.roblox.com/v1/usernames/users';
const ROBLOX_USER_URL = 'https://users.roblox.com/v1/users/';
const ROBLOX_AVATAR_URL = 'https://thumbnails.roblox.com/v1/users/avatar-headshot?format=Png&size=420x420&userIds=';
const VERIFICATION_GUILD_ID = '1487258655840669807';
const COMMAND_GUILD_ID = '1454217001626243288';
const VERIFICATION_PANEL_ROLE_ID = '1518410191933014057';
const UNLINK_ROLE_ID = '1487276505712033883';
const VERIFICATION_LOG_CHANNEL_ID = '1546193398388494336';
const VERIFICATION_CODE_LENGTH = 6;
const VERIFICATION_EXPIRY_MINUTES = 15;
const DATABASE_RETRY_DELAY_MS = 60_000;
const QUICK_TUNNEL_START_TIMEOUT_MS = 30_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const robloxCommands = [
  new SlashCommandBuilder()
    .setName('verification-panel')
    .setDescription('Poste le panneau de vérification Roblox.'),
  new SlashCommandBuilder()
    .setName('who-is')
    .setDescription('Recherche la liaison Discord ou Roblox d’une personne.')
    .addUserOption((option) => option
      .setName('discord')
      .setDescription('Membre Discord à rechercher')
      .setRequired(false))
    .addStringOption((option) => option
      .setName('roblox')
      .setDescription('Pseudo Roblox à rechercher')
      .setRequired(false)
      .setMaxLength(20)),
  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Détache le compte Roblox d’un utilisateur.')
    .addUserOption((option) => option
      .setName('utilisateur')
      .setDescription('Utilisateur à délier')
      .setRequired(true)),
];

class RobloxApiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

function createMysqlPool() {
  const requiredVariables = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'];
  const missingVariables = requiredVariables.filter((name) => process.env[name] === undefined || process.env[name] === '');

  if (missingVariables.length) {
    console.error(`[Roblox] MySQL is not configured; missing: ${missingVariables.join(', ')}. Roblox linking and death delivery are unavailable until it is configured.`);
    return null;
  }

  const configuredPort = Number.parseInt(process.env.MYSQL_PORT || '3306', 10);
  if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
    console.error('[Roblox] MYSQL_PORT is invalid. Roblox linking and death delivery are unavailable until it is corrected.');
    return null;
  }

  return mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: configuredPort,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 3,
    queueLimit: 0,
    connectTimeout: 10_000,
  });
}

function generateVerificationCode() {
  let code = '';
  for (let index = 0; index < VERIFICATION_CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function portFromEnvironment() {
  const port = Number.parseInt(process.env.PORT || '8080', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer from 0 to 65535.');
  }
  return port;
}

function bearerTokenFrom(request) {
  const authorization = request.get('authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

function tokensMatch(providedToken, expectedToken) {
  if (!providedToken || !expectedToken) return false;

  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(expectedToken);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function validDeathPayload(payload) {
  return Boolean(
    payload
    && typeof payload.eventId === 'string'
    && payload.eventId.length > 0
    && payload.eventId.length <= 100
    && payload.eventType === 'permadeath_death'
    && Number.isSafeInteger(payload.occurredAt)
    && payload.occurredAt > 0
    && Number.isSafeInteger(payload.robloxUserId)
    && payload.robloxUserId > 0
    && typeof payload.robloxUsername === 'string'
    && payload.robloxUsername.length > 0
    && payload.robloxUsername.length <= 20
    && typeof payload.robloxDisplayName === 'string',
  );
}

async function fetchRobloxJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') {
      throw new RobloxApiError('network', 'Roblox did not respond in time.');
    }
    throw new RobloxApiError('network', 'Roblox could not be reached.');
  }

  if (response.status === 429) {
    throw new RobloxApiError('rateLimit', 'Roblox is rate-limiting requests.');
  }

  if (response.status === 404) {
    throw new RobloxApiError('notFound', 'This Roblox account was not found.');
  }

  if (!response.ok) {
    throw new RobloxApiError('network', `Roblox returned HTTP ${response.status}.`);
  }

  try {
    return await response.json();
  } catch {
    throw new RobloxApiError('network', 'Roblox returned an invalid response.');
  }
}

const robloxUserCache = new Map();
const robloxProfileCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const EMBED_COLOR = 0x2B2D31;
const EMBED_SEPARATOR = '────────────────────────────────────────';

function formatTitle(title) {
  return title.startsWith('◆ ') ? title : `◆ ${title}`;
}

async function findRobloxUser(username) {
  const cacheKey = username.toLowerCase();
  const cached = robloxUserCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }
  const body = JSON.stringify({
    usernames: [username],
    excludeBannedUsers: false,
  });
  const data = await fetchRobloxJson(ROBLOX_USERNAME_LOOKUP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const user = data.data?.[0];
  if (!user?.id || !user?.name) {
    throw new RobloxApiError('notFound', 'This Roblox username was not found.');
  }

  const result = { id: user.id, username: user.name };
  robloxUserCache.set(cacheKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

async function getRobloxProfile(robloxUserId) {
  const cached = robloxProfileCache.get(robloxUserId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }
  const user = await fetchRobloxJson(`${ROBLOX_USER_URL}${robloxUserId}`);
  if (!user?.id || !user?.name) {
    throw new RobloxApiError('notFound', 'This Roblox account no longer exists.');
  }

  const result = {
    id: user.id,
    username: user.name,
    displayName: user.displayName || user.name,
    description: user.description || '',
    created: user.created || null,
  };
  robloxProfileCache.set(robloxUserId, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

async function getRobloxAvatarUrl(robloxUserId) {
  const data = await fetchRobloxJson(`${ROBLOX_AVATAR_URL}${robloxUserId}`);
  const imageUrl = data.data?.[0]?.imageUrl;
  if (!imageUrl) throw new RobloxApiError('network', 'Roblox did not return an avatar.');
  return imageUrl;
}

function robloxErrorMessage(error) {
  if (error instanceof RobloxApiError) {
    if (error.kind === 'notFound') return 'Compte Roblox introuvable. Vérifie le nom d’utilisateur et réessaie.';
    if (error.kind === 'rateLimit') return 'Roblox limite temporairement les vérifications. Réessaie dans quelques minutes.';
    return 'Impossible de joindre Roblox pour le moment. Réessaie bientôt.';
  }
  return 'Une erreur inattendue est survenue pendant la vérification Roblox.';
}

function deathDmEmbed(payload) {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle(formatTitle('NOTIFICATION DE MORT'))
    .setDescription(
      `Tu es mort durant une session roleplay.\n\n${EMBED_SEPARATOR}\n\n**Personnage :** ${payload.robloxUsername}\nTon personnage est désormais mort de manière roleplay. Si tu trouves cette mort injuste, ouvre un **ticket** afin de la contester.\n\n*L’équipe lore de Site-66.*`,
    )
    .setFooter({ text: 'FPCS Utilities' })
    .setTimestamp(new Date(payload.occurredAt * 1000));
}

export function createRobloxIntegration({ client, guildId }) {
  const pool = createMysqlPool();
  let databaseReady = false;
  let databaseInitialization = null;
  let lastDatabaseAttemptAt = 0;
  let httpServer = null;
  let quickTunnel = null;

  const app = express();
  app.use(express.json({ limit: '32kb' }));

  app.use((error, _request, response, next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({ error: 'Invalid JSON body.' });
      return;
    }
    next(error);
  });

  async function initializeDatabase({ force = false } = {}) {
    if (!pool) return false;
    if (databaseReady) return true;
    if (databaseInitialization) return databaseInitialization;
    if (!force && Date.now() - lastDatabaseAttemptAt < DATABASE_RETRY_DELAY_MS) return false;

    lastDatabaseAttemptAt = Date.now();
    databaseInitialization = (async () => {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS roblox_discord_links (
            discord_user_id VARCHAR(20) NOT NULL PRIMARY KEY,
            roblox_user_id BIGINT UNSIGNED NOT NULL UNIQUE,
            roblox_username VARCHAR(20) NOT NULL,
            verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        const [linkColumns] = await pool.query(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roblox_discord_links'
             AND COLUMN_NAME = 'verification_rank'`,
        );
        if (!linkColumns.length) {
          await pool.query(
            'ALTER TABLE roblox_discord_links ADD COLUMN verification_rank BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE AFTER discord_user_id',
          );
        }
        await pool.query(`
          CREATE TABLE IF NOT EXISTS roblox_pending_links (
            discord_user_id VARCHAR(20) NOT NULL PRIMARY KEY,
            roblox_user_id BIGINT UNSIGNED NOT NULL UNIQUE,
            roblox_username VARCHAR(20) NOT NULL,
            verification_code CHAR(6) NOT NULL UNIQUE,
            expires_at DATETIME NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS roblox_processed_death_events (
            event_id VARCHAR(100) NOT NULL PRIMARY KEY,
            received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS strikes (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            discord_id VARCHAR(20) NOT NULL,
            moderator_discord_id VARCHAR(20) NOT NULL,
            raison VARCHAR(1000) NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX strikes_discord_id_idx (discord_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        databaseReady = true;
        console.log('[Roblox] MySQL tables are ready.');
        return true;
      } catch (error) {
        databaseReady = false;
        console.error('[Roblox] MySQL initialization failed. The bot will stay online and retry only when Roblox functionality is used:', error.message);
        return false;
      } finally {
        databaseInitialization = null;
      }
    })();

    return databaseInitialization;
  }

  async function requireDatabase(interaction) {
    if (await initializeDatabase()) return true;

    if (interaction) {
      await interaction.editReply('Le système de liaison Roblox est temporairement indisponible. Réessaie plus tard.');
    }
    return false;
  }

  function markDatabaseUnavailable(error) {
    databaseReady = false;
    console.error('[Roblox] MySQL operation failed. Roblox functionality is temporarily unavailable:', error.message);
  }

  async function sendVerificationLog({ title, color, interaction, description, fields }) {
    try {
      const channel = await client.channels.fetch(VERIFICATION_LOG_CHANNEL_ID);
      if (!channel?.isTextBased() || !channel.isSendable() || channel.guildId !== VERIFICATION_GUILD_ID) {
        throw new Error(`Verification log channel ${VERIFICATION_LOG_CHANNEL_ID} is unavailable.`);
      }

      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description)
        .addFields(
          { name: 'Discord', value: `${interaction.user} (${interaction.user.tag}, ${interaction.user.id})`, inline: false },
          ...fields,
        )
        .setTimestamp();
      await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
      console.error('[Roblox] Unable to send verification log:', error.message);
    }
  }

  async function createPendingLink(discordUserId, robloxUser) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const verificationCode = generateVerificationCode();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute('DELETE FROM roblox_pending_links WHERE discord_user_id = ?', [discordUserId]);
        await connection.execute(
          `INSERT INTO roblox_pending_links
            (discord_user_id, roblox_user_id, roblox_username, verification_code, expires_at)
           VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${VERIFICATION_EXPIRY_MINUTES} MINUTE))`,
          [discordUserId, robloxUser.id, robloxUser.username, verificationCode],
        );
        await connection.commit();
        return verificationCode;
      } catch (error) {
        await connection.rollback();
        if (error.code !== 'ER_DUP_ENTRY' || attempt === 4) throw error;
      } finally {
        connection.release();
      }
    }

    throw new Error('Unable to generate a unique verification code.');
  }

  async function databaseAvailable(interaction) {
    if (await initializeDatabase()) return true;
    await interaction.reply({ content: 'Le système de vérification Roblox est temporairement indisponible. Réessaie plus tard.', ephemeral: true });
    return false;
  }

  async function handleVerificationPanel(interaction) {
    const permissionGuild = client.guilds.cache.get(VERIFICATION_GUILD_ID);
    const permissionMember = permissionGuild ? await permissionGuild.members.fetch(interaction.user.id).catch(() => null) : null;
    if (!permissionMember?.roles.cache.has(VERIFICATION_PANEL_ROLE_ID)) {
      await interaction.reply({ content: 'Tu n’as pas le rôle nécessaire pour poster le panneau de vérification.', ephemeral: true });
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle(formatTitle('Vérifie ton Roblox'))
      .setDescription(`Le bot te demandera d’inscrire ton utilisateur Roblox et de mettre un code dans ta bio Roblox.\n\n${EMBED_SEPARATOR}\n\nClique sur « **Se vérifier** » ci-dessous pour démarrer.`);
    const button = new ButtonBuilder()
      .setCustomId('verify_panel_start')
      .setLabel('Se vérifier')
      .setStyle(ButtonStyle.Primary);
    await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] });
  }

  async function handleVerificationStart(interaction) {
    if (!(await databaseAvailable(interaction))) return;
    try {
      const [links] = await pool.execute(
        'SELECT roblox_username FROM roblox_discord_links WHERE discord_user_id = ? LIMIT 1',
        [interaction.user.id],
      );
      if (links[0]) {
        await interaction.reply({ content: `Tu es déjà vérifié avec le compte Roblox lié : **${links[0].roblox_username}**.`, ephemeral: true });
        return;
      }

      const modal = new ModalBuilder().setCustomId('verify_panel_username').setTitle('Vérifie ton Roblox');
      const usernameInput = new TextInputBuilder()
        .setCustomId('roblox_username')
        .setLabel('Pseudo Roblox')
        .setPlaceholder('Ton nom d’utilisateur Roblox')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(20);
      modal.addComponents(new ActionRowBuilder().addComponents(usernameInput));
      await interaction.showModal(modal);
    } catch (error) {
      markDatabaseUnavailable(error);
      await interaction.reply({ content: 'Impossible de démarrer la vérification. Réessaie plus tard.', ephemeral: true }).catch(() => {});
    }
  }

  async function handleVerificationUsername(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!(await requireDatabase(interaction))) return;

    try {
      const requestedUsername = interaction.fields.getTextInputValue('roblox_username').trim();
      const robloxUser = await findRobloxUser(requestedUsername);
      const [existingLinks] = await pool.execute(
        'SELECT discord_user_id FROM roblox_discord_links WHERE roblox_user_id = ? LIMIT 1',
        [robloxUser.id],
      );
      if (existingLinks[0] && existingLinks[0].discord_user_id !== interaction.user.id) {
        await interaction.editReply('Ce compte Roblox est déjà lié à un autre compte Discord.');
        return;
      }

      await pool.execute('DELETE FROM roblox_pending_links WHERE roblox_user_id = ? AND expires_at <= UTC_TIMESTAMP()', [robloxUser.id]);
      const [existingPendingLinks] = await pool.execute(
        'SELECT discord_user_id FROM roblox_pending_links WHERE roblox_user_id = ? LIMIT 1',
        [robloxUser.id],
      );
      if (existingPendingLinks[0] && existingPendingLinks[0].discord_user_id !== interaction.user.id) {
        await interaction.editReply('Une vérification est déjà en cours pour ce compte Roblox. Réessaie plus tard.');
        return;
      }

      const verificationCode = await createPendingLink(interaction.user.id, robloxUser);
      const button = new ButtonBuilder()
        .setCustomId('verify_panel_check')
        .setLabel('Vérifier mon code')
        .setStyle(ButtonStyle.Success);
      const verificationEmbed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(formatTitle('Code de vérification Roblox'))
        .setDescription(
          `Place ce code dans la section **About / Bio** de ton profil Roblox :\n\n\`\`\`\n${verificationCode}\n\`\`\`\n\n${EMBED_SEPARATOR}\n\nTu as **15 minutes** pour le placer, puis clique sur **Vérifier mon code**. Tu pourras retirer le code de ta bio après la vérification.`,
        )
        .setFooter({ text: 'FPCS Utilities' })
        .setTimestamp();
      await interaction.editReply({
        embeds: [verificationEmbed],
        components: [new ActionRowBuilder().addComponents(button)],
      });
      await sendVerificationLog({
        title: 'Demande de liaison initiée',
        color: 0x3498DB,
        interaction,
        description: 'Une demande de vérification Roblox a été créée.',
        fields: [{ name: 'Pseudo Roblox visé', value: robloxUser.username, inline: true }],
      });
    } catch (error) {
      if (error instanceof RobloxApiError) {
        await interaction.editReply(robloxErrorMessage(error));
        return;
      }
      markDatabaseUnavailable(error);
      await interaction.editReply('Impossible de créer la demande de vérification. Réessaie plus tard.');
    }
  }

  async function saveVerifiedLink(discordUserId, pendingLink, robloxUsername) {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [conflicts] = await connection.execute(
        'SELECT discord_user_id FROM roblox_discord_links WHERE roblox_user_id = ? FOR UPDATE',
        [pendingLink.roblox_user_id],
      );

      if (conflicts[0] && conflicts[0].discord_user_id !== discordUserId) {
        await connection.rollback();
        return false;
      }

      await connection.execute('DELETE FROM roblox_discord_links WHERE discord_user_id = ?', [discordUserId]);
      const [insertResult] = await connection.execute(
        `INSERT INTO roblox_discord_links (discord_user_id, roblox_user_id, roblox_username)
         VALUES (?, ?, ?)`,
        [discordUserId, pendingLink.roblox_user_id, robloxUsername],
      );
      await connection.execute('DELETE FROM roblox_pending_links WHERE discord_user_id = ?', [discordUserId]);
      await connection.commit();
      return insertResult.insertId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function handleVerificationCheck(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!(await requireDatabase(interaction))) return;

    try {
      const [pendingLinks] = await pool.execute(
        `SELECT
           roblox_user_id,
           roblox_username,
           verification_code,
           expires_at,
           TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), expires_at) AS seconds_remaining
         FROM roblox_pending_links
         WHERE discord_user_id = ?
         LIMIT 1`,
        [interaction.user.id],
      );
      const pendingLink = pendingLinks[0];

      if (!pendingLink) {
        await interaction.editReply('Aucune demande de liaison active. Clique sur le bouton principal du panneau pour recommencer.');
        return;
      }

      if (Number(pendingLink.seconds_remaining) <= 0) {
        await pool.execute('DELETE FROM roblox_pending_links WHERE discord_user_id = ?', [interaction.user.id]);
        await interaction.editReply('Ton code a expiré. Clique sur le bouton principal du panneau pour en générer un nouveau.');
        return;
      }

      const profile = await getRobloxProfile(pendingLink.roblox_user_id);
      if (!profile.description.includes(pendingLink.verification_code)) {
        await interaction.editReply(
          `Je ne trouve pas le code \`${pendingLink.verification_code}\` dans ta bio Roblox. Vérifie qu’il est bien enregistré, puis réessaie avant son expiration.`,
        );
        return;
      }

      const verificationRank = await saveVerifiedLink(interaction.user.id, pendingLink, profile.username);
      if (!verificationRank) {
        await interaction.editReply('Ce compte Roblox vient d’être lié à un autre compte Discord.');
        return;
      }

      await interaction.editReply(
        `Liaison réussie : **${profile.username}** est maintenant associé à ton compte Discord. Ton tag interne est **#${verificationRank}**. Tu peux retirer le code de ta bio Roblox.`,
      );
      await sendVerificationLog({
        title: 'Vérification Roblox réussie',
        color: 0x2ECC71,
        interaction,
        description: 'Une liaison Discord-Roblox a été confirmée.',
        fields: [
          { name: 'Pseudo Roblox', value: profile.username, inline: true },
          { name: 'Tag interne', value: `#${verificationRank}`, inline: true },
        ],
      });
    } catch (error) {
      if (error instanceof RobloxApiError) {
        await interaction.editReply(robloxErrorMessage(error));
        return;
      }
      markDatabaseUnavailable(error);
      await interaction.editReply('Impossible de vérifier la liaison pour le moment. Réessaie plus tard.');
    }
  }

  async function handleUnlink(interaction) {
    const permissionGuild = client.guilds.cache.get(VERIFICATION_GUILD_ID);
    const permissionMember = permissionGuild ? await permissionGuild.members.fetch(interaction.user.id).catch(() => null) : null;
    if (!permissionMember?.roles.cache.has(UNLINK_ROLE_ID)) {
      await interaction.reply({ content: 'Tu n’as pas le niveau de rôle nécessaire pour utiliser cette commande.', ephemeral: true });
      return;
    }
    const target = interaction.options.getUser('utilisateur', true);
    await interaction.deferReply({ ephemeral: true });
    if (!(await requireDatabase(interaction))) return;

    try {
      const [links] = await pool.execute(
        'SELECT roblox_username FROM roblox_discord_links WHERE discord_user_id = ? LIMIT 1',
        [target.id],
      );
      const link = links[0];
      if (!link) {
        await interaction.editReply(`Aucun compte Roblox n’est actuellement lié au compte Discord de ${target}.`);
        return;
      }

      await pool.execute('DELETE FROM roblox_discord_links WHERE discord_user_id = ?', [target.id]);
      await interaction.editReply(`La liaison de ${target} avec **${link.roblox_username}** a été supprimée avec succès.`);
      await sendVerificationLog({
        title: 'Liaison Roblox supprimée',
        color: 0xE67E22,
        interaction,
        description: 'Un utilisateur a détaché son compte Roblox.',
        fields: [
          { name: 'Utilisateur délié', value: `${target} (${target.id})`, inline: true },
          { name: 'Pseudo Roblox', value: link.roblox_username, inline: true },
        ],
      });
    } catch (error) {
      markDatabaseUnavailable(error);
      await interaction.editReply('Impossible de supprimer la liaison pour le moment. Réessaie plus tard.');
    }
  }

  function accountAge(createdAt) {
    const created = new Date(createdAt);
    if (Number.isNaN(created.getTime())) return null;
    const now = new Date();
    let years = now.getUTCFullYear() - created.getUTCFullYear();
    let months = now.getUTCMonth() - created.getUTCMonth();
    let days = now.getUTCDate() - created.getUTCDate();
    if (days < 0) {
      months -= 1;
      days += new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate();
    }
    if (months < 0) {
      years -= 1;
      months += 12;
    }
    const parts = [];
    if (years) parts.push(`${years} an${years > 1 ? 's' : ''}`);
    if (months) parts.push(`${months} mois`);
    if (!parts.length || days) parts.push(`${days} jour${days > 1 ? 's' : ''}`);
    return `${created.toLocaleDateString('fr-FR')} (${parts.join(', ')})`;
  }

  async function handleWhoIs(interaction) {
    const discordUser = interaction.options.getUser('discord');
    const requestedRoblox = interaction.options.getString('roblox')?.trim();
    if (!discordUser && !requestedRoblox) {
      await interaction.reply({ content: 'Renseigne au moins l’un des champs `discord` ou `roblox`.', ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    if (!(await requireDatabase(interaction))) return;

    try {
      let link;
      if (discordUser) {
        const [links] = await pool.execute(
          `SELECT discord_user_id, roblox_user_id, roblox_username, verification_rank
           FROM roblox_discord_links WHERE discord_user_id = ? LIMIT 1`,
          [discordUser.id],
        );
        link = links[0];
      } else {
        const [links] = await pool.execute(
          `SELECT discord_user_id, roblox_user_id, roblox_username, verification_rank
           FROM roblox_discord_links
           WHERE LOWER(roblox_username) = LOWER(?) LIMIT 1`,
          [requestedRoblox],
        );
        link = links[0];
      }

      if (!link) {
        await interaction.editReply(discordUser
          ? 'Cette personne n’est pas vérifiée ou sa liaison est introuvable.'
          : 'Aucune liaison vérifiée ne correspond à ce pseudo Roblox.');
        return;
      }

      const [strikeRows] = await pool.execute(
        'SELECT COUNT(*) AS total FROM strikes WHERE discord_id = ?',
        [link.discord_user_id],
      );
      const strikeCount = Number(strikeRows[0]?.total ?? 0);

      let resolvedDiscordUser = discordUser;
      if (!resolvedDiscordUser) {
        try {
          resolvedDiscordUser = await interaction.client.users.fetch(link.discord_user_id);
        } catch {
          resolvedDiscordUser = null;
        }
      }

      let profile = null;
      let robloxAge = null;
      let robloxError = null;
      try {
        profile = await getRobloxProfile(link.roblox_user_id);
        robloxAge = accountAge(profile.created);
      } catch (error) {
        robloxError = robloxErrorMessage(error);
      }

      const discordCreated = accountAge(resolvedDiscordUser?.createdAt);
      let avatarUrl = null;
      if (discordUser) {
        try {
          avatarUrl = await getRobloxAvatarUrl(link.roblox_user_id);
        } catch (error) {
          robloxError ??= robloxErrorMessage(error);
        }
      } else {
        avatarUrl = resolvedDiscordUser?.displayAvatarURL({ extension: 'png', size: 256 }) ?? null;
      }
      const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(formatTitle('Liaison vérifiée'))
        .setDescription([
          `**Discord :** ${resolvedDiscordUser ? `${resolvedDiscordUser} (\`${resolvedDiscordUser.id}\`)` : `<@${link.discord_user_id}>`}`,
          `**Roblox :** ${profile ? `**${profile.username}**${profile.displayName !== profile.username ? ` (${profile.displayName})` : ''}` : `**${link.roblox_username}**`}`,
          `**Tag de vérification :** \`#${link.verification_rank}\` | **Strikes actifs :** \`${strikeCount}\``,
          EMBED_SEPARATOR,
          `**Âge Discord :** ${discordCreated ? `<t:${Math.floor(resolvedDiscordUser.createdTimestamp / 1000)}:D> (${discordCreated})` : 'Information indisponible'}`,
          `**Âge Roblox :** ${robloxAge ? `<t:${Math.floor(new Date(profile.created).getTime() / 1000)}:D> (${robloxAge})` : `Information indisponible${robloxError ? ` : ${robloxError}` : '.'}`}`,
        ].join('\n'))
        .setFooter({ text: 'FPCS Utilities' });
      if (avatarUrl) embed.setThumbnail(avatarUrl);
      const strikesButton = new ButtonBuilder()
        .setCustomId(`strikes_view:${link.discord_user_id}`)
        .setLabel('Voir les strikes')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(strikeCount === 0);
      await interaction.editReply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(strikesButton)],
      });
    } catch (error) {
      markDatabaseUnavailable(error);
      await interaction.editReply('Impossible d’effectuer cette recherche pour le moment. Réessaie plus tard.');
    }
  }

  async function handleRobloxInteraction(interaction) {
    if (interaction.isChatInputCommand()) {
      if (interaction.guildId !== guildId && interaction.guildId !== VERIFICATION_GUILD_ID && interaction.guildId !== COMMAND_GUILD_ID) return false;
      if (interaction.commandName === 'verification-panel') {
        await handleVerificationPanel(interaction);
        return true;
      }
      if (interaction.commandName === 'who-is') {
        await handleWhoIs(interaction);
        return true;
      }
      if (interaction.commandName === 'unlink') {
        await handleUnlink(interaction);
        return true;
      }
    }
    if (interaction.isButton()) {
      if (interaction.customId === 'verify_panel_start') {
        await handleVerificationStart(interaction);
        return true;
      }
      if (interaction.customId === 'verify_panel_check') {
        await handleVerificationCheck(interaction);
        return true;
      }
    }
    if (interaction.isModalSubmit() && interaction.customId === 'verify_panel_username') {
      await handleVerificationUsername(interaction);
      return true;
    }
    return false;
  }

  app.post('/v1/roblox/permadeath-death', async (request, response) => {
    if (!tokensMatch(bearerTokenFrom(request), process.env.ROBLOX_EVENT_SECRET)) {
      response.status(401).json({ error: 'Unauthorized.' });
      return;
    }

    if (!validDeathPayload(request.body)) {
      response.status(400).json({ error: 'Invalid permadeath death payload.' });
      return;
    }

    if (!(await initializeDatabase())) {
      response.status(503).json({ error: 'Database temporarily unavailable.' });
      return;
    }

    const payload = request.body;
    try {
      const [insertResult] = await pool.execute(
        'INSERT IGNORE INTO roblox_processed_death_events (event_id) VALUES (?)',
        [payload.eventId],
      );

      if (insertResult.affectedRows === 0) {
        response.status(200).json({ ok: true, duplicate: true });
        return;
      }

      const [links] = await pool.execute(
        'SELECT discord_user_id FROM roblox_discord_links WHERE roblox_user_id = ? LIMIT 1',
        [payload.robloxUserId],
      );
      const link = links[0];

      if (!link) {
        console.log(`[Roblox] No Discord link for Roblox user ${payload.robloxUserId}; death event ${payload.eventId} ignored.`);
        response.status(200).json({ ok: true, linked: false });
        return;
      }

      try {
        const discordUser = await client.users.fetch(link.discord_user_id);
        await discordUser.send({
          embeds: [deathDmEmbed(payload)],
          allowedMentions: { parse: [] },
        });
        console.log(`[Roblox] Sent permadeath DM for event ${payload.eventId} to Discord user ${link.discord_user_id}.`);
        response.status(200).json({ ok: true, linked: true, delivered: true });
      } catch (error) {
        console.error(`[Roblox] Could not DM Discord user ${link.discord_user_id} for event ${payload.eventId}:`, error.message);
        response.status(200).json({ ok: true, linked: true, delivered: false });
      }
    } catch (error) {
      markDatabaseUnavailable(error);
      response.status(503).json({ error: 'Database temporarily unavailable.' });
    }
  });

  function startQuickTunnel(port) {
    const localServiceUrl = `http://127.0.0.1:${port}`;
    let publicUrlAnnounced = false;
    let startupTimeout;

    try {
      const tunnel = Tunnel.quick(localServiceUrl, { '--no-autoupdate': true });
      quickTunnel = tunnel;

      startupTimeout = setTimeout(() => {
        if (!publicUrlAnnounced) {
          console.error(`[Roblox] Cloudflare Quick Tunnel did not provide a public URL within ${QUICK_TUNNEL_START_TIMEOUT_MS / 1000} seconds.`);
        }
      }, QUICK_TUNNEL_START_TIMEOUT_MS);
      startupTimeout.unref();

      tunnel.once('url', (baseUrl) => {
        publicUrlAnnounced = true;
        clearTimeout(startupTimeout);
        console.log(`[Roblox] Webhook public URL: ${baseUrl}/v1/roblox/permadeath-death`);
      });
      tunnel.on('error', (error) => {
        clearTimeout(startupTimeout);
        console.error('[Roblox] Cloudflare Quick Tunnel could not start:', error.message);
      });
      tunnel.on('exit', (code, signal) => {
        clearTimeout(startupTimeout);
        if (quickTunnel === tunnel) quickTunnel = null;
        if (!publicUrlAnnounced) {
          console.error(`[Roblox] Cloudflare Quick Tunnel exited before it was ready (code=${code}, signal=${signal ?? 'none'}).`);
        } else {
          console.error(`[Roblox] Cloudflare Quick Tunnel stopped (code=${code}, signal=${signal ?? 'none'}). The webhook is no longer public.`);
        }
        if (httpServer) {
          console.log('[Roblox] Scheduling Cloudflare Quick Tunnel reconnection in 5 seconds...');
          setTimeout(() => {
            if (!quickTunnel && httpServer) {
              console.log('[Roblox] Attempting Cloudflare Quick Tunnel reconnection...');
              startQuickTunnel(port);
            }
          }, 5000).unref();
        }
      });
    } catch (error) {
      console.error('[Roblox] Cloudflare Quick Tunnel could not start:', error.message);
    }
  }

  function stopQuickTunnel() {
    if (!quickTunnel) return;
    quickTunnel.stop();
    quickTunnel = null;
  }

  function startHttpServer({ startTunnel = true } = {}) {
    if (httpServer) return httpServer;

    const port = portFromEnvironment();
    if (!process.env.ROBLOX_EVENT_SECRET) {
      console.error('[Roblox] ROBLOX_EVENT_SECRET is not configured. The death webhook will reject every request.');
    }

    httpServer = app.listen(port, () => {
      const address = httpServer.address();
      const activePort = typeof address === 'object' && address ? address.port : port;
      console.log(`[Roblox] Death webhook listening on port ${activePort}.`);
      if (startTunnel) startQuickTunnel(activePort);
    });
    httpServer.on('error', (error) => {
      console.error('[Roblox] Death webhook server error:', error.message);
    });
    return httpServer;
  }

  async function stopHttpServer() {
    if (!httpServer) return;
    stopQuickTunnel();
    await new Promise((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
    httpServer = null;
  }

  return {
    initializeDatabase,
    startHttpServer,
    stopHttpServer,
    stopQuickTunnel,
    handleInteraction: handleRobloxInteraction,
  };
}
