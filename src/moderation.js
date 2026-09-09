import mysql from 'mysql2/promise';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { createV2Message, createV2EphemeralError } from './components.js';
import { MODERATION_ROLE_ID, SUPER_ADMIN_ROLE_ID, hasGuildPermission } from './permissions.js';

const MODERATION_GUILD_ID = '1487258655840669807';
const LOG_CHANNEL_ID = '1546193398388494336';
const UNLINK_ROLE_ID = '1487276505712033883';
const STRIKE_TABLE = 'strikes';
const CASE_TABLE = 'moderation_cases';
const BAN_TABLE = 'moderation_bans';
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

export const moderationCommands = [
  new SlashCommandBuilder()
    .setName('avertissement')
    .setDescription('Attribue un avertissement à un utilisateur.')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addStringOption((option) => option.setName('raison').setDescription('Raison de l’avertissement').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('exclusion')
    .setDescription('Place un utilisateur en exclusion temporaire sur tous les serveurs.')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addStringOption((option) => option.setName('raison').setDescription('Raison de l’exclusion').setRequired(true).setMaxLength(1000))
    .addStringOption((option) => option
      .setName('duree')
      .setDescription('Durée : 30m, 1h ou 2d (maximum 28 jours)')
      .setRequired(true)
      .setMaxLength(10)),
  new SlashCommandBuilder()
    .setName('bannissement-global')
    .setDescription('Bannit un utilisateur sur tous les serveurs.')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addStringOption((option) => option.setName('raison').setDescription('Raison du bannissement').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('fin-exclusion')
    .setDescription('Retire l’exclusion temporaire d’un utilisateur sur tous les serveurs.')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addStringOption((option) => option.setName('raison').setDescription('Raison du retrait').setRequired(false).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('fin-bannissement')
    .setDescription('Retire le bannissement d’un utilisateur sur tous les serveurs.')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addStringOption((option) => option.setName('raison').setDescription('Raison du retrait').setRequired(false).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('purgeavertissement')
    .setDescription('Purger en totalité les avertissements d’une personne')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addStringOption((option) => option.setName('raison').setDescription('Raison du retrait').setRequired(false).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('purgecasier')
    .setDescription('Purge en totalité le casier de modération d’une personne.')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addStringOption((option) => option.setName('raison').setDescription('Raison de la purge').setRequired(false).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('retireravertissement')
    .setDescription('Retire un avertissement précis d’une personne.')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addIntegerOption((option) => option
      .setName('avertissement')
      .setDescription('Identifiant affiché dans le casier de modération')
      .setRequired(true)
      .setMinValue(1))
    .addStringOption((option) => option.setName('raison').setDescription('Raison du retrait').setRequired(false).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('expulsion')
    .setDescription('Expulse un utilisateur de tous les serveurs où le bot est présent.')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addStringOption((option) => option.setName('raison').setDescription('Raison de l’expulsion').setRequired(true).setMaxLength(1000)),
];

function createPool() {
  const required = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'];
  if (required.some((name) => !process.env[name])) return null;
  return mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number.parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 3,
    queueLimit: 0,
    connectTimeout: 10_000,
  });
}

function logField(name, value, inline = false) {
  return { name, value: String(value).slice(0, 1024) || '—', inline };
}

function moderatorLabel(interaction) {
  return `${interaction.user.tag} (${interaction.user.id})`;
}

async function safeEditReply(interaction, payload) {
  try {
    await interaction.editReply(payload);
  } catch (error) {
    console.error('[Moderation] Unable to publish command confirmation:', error.message);
  }
}

function parseTimeoutDuration(value) {
  const match = value.trim().toLowerCase().match(/^(\d+)([mhd])$/);
  if (!match) return null;

  const amount = Number(match[1]);
  const multipliers = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };
  const milliseconds = amount * multipliers[match[2]];
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 60_000 || milliseconds > MAX_TIMEOUT_MS) return null;

  return { milliseconds, label: `${amount}${match[2]}` };
}

export function createModerationIntegration({ client }) {
  const pool = createPool();
  let databaseReady = false;
  let databaseInitialization;

  async function hasModerationAccess(interaction) {
    const guildIds = [...new Set([interaction.guildId, MODERATION_GUILD_ID].filter(Boolean))];
    console.log('[Moderation] Permission check started:', {
      commandName: interaction.commandName,
      user: `${interaction.user.tag} (${interaction.user.id})`,
      interactionGuildId: interaction.guildId,
      guildsToCheck: guildIds,
      allowedRoleIds: [MODERATION_ROLE_ID, SUPER_ADMIN_ROLE_ID],
    });
    for (const guildId of guildIds) {
      const allowed = await hasGuildPermission({
        client,
        guildId,
        userId: interaction.user.id,
        allowedRoleIds: [MODERATION_ROLE_ID, SUPER_ADMIN_ROLE_ID],
        ignoreNativePermissions: true,
      });
      console.log(`[Moderation] Permission result for guild ${guildId}: ${allowed ? 'ALLOWED' : 'DENIED'}`);
      if (allowed) {
        return true;
      }
    }
    console.warn(`[Moderation] Permission denied for ${interaction.user.id}.`);
    return false;
  }

  async function initializeDatabase() {
    if (!pool) return false;
    if (databaseReady) return true;
    if (databaseInitialization) return databaseInitialization;
    databaseInitialization = (async () => {
      try {
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ${STRIKE_TABLE} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            discord_id VARCHAR(20) NOT NULL,
            moderator_discord_id VARCHAR(20) NOT NULL,
            raison VARCHAR(1000) NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX strikes_discord_id_idx (discord_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ${CASE_TABLE} (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            discord_id VARCHAR(20) NOT NULL,
            type VARCHAR(32) NOT NULL,
            moderator_discord_id VARCHAR(20) NOT NULL,
            raison VARCHAR(1000) NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX moderation_cases_discord_id_idx (discord_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS ${BAN_TABLE} (
            discord_id VARCHAR(20) NOT NULL,
            guild_id VARCHAR(20) NOT NULL,
            guild_name VARCHAR(100) NOT NULL,
            banned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (discord_id, guild_id)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        databaseReady = true;
        return true;
      } catch (error) {
        console.error('[Moderation] MySQL initialization failed:', error.message);
        return false;
      } finally {
        databaseInitialization = null;
      }
    })();
    return databaseInitialization;
  }

  async function sendLog(title, description, fields) {
    try {
      const channel = await client.channels.fetch(LOG_CHANNEL_ID);
      if (!channel?.isTextBased() || !channel.isSendable() || channel.guildId !== MODERATION_GUILD_ID) {
        return;
      }
      const moderator = fields.find((field) => field.name === 'Modérateur')?.value ?? '—';
      const reason = fields.find((field) => field.name === 'Raison')?.value ?? '—';
      const extraFields = fields.filter((field) => field.name !== 'Modérateur' && field.name !== 'Raison');
      const sections = [];
      if (reason && reason !== '—') sections.push(`**Raison :** ${reason}`);
      if (extraFields.length) {
        sections.push(extraFields.map((f) => `**${f.name} :** ${f.value}`).join('\n'));
      }
      await channel.send(createV2Message({
        title,
        description: `${description}\n**Modérateur :** ${moderator}`,
        sections,
      }));
    } catch (error) {
      console.error('[Moderation] Unable to send log:', error.message);
    }
  }

  async function ensureDatabase(interaction) {
    if (await initializeDatabase()) return true;
    const errorPayload = createV2EphemeralError('Le système de modération est temporairement indisponible.', 'Modération indisponible');
    if (interaction.deferred || interaction.replied) await interaction.editReply(errorPayload);
    else await interaction.reply(errorPayload);
    return false;
  }

  async function ensureModerationAccess(interaction) {
    if (await hasModerationAccess(interaction)) return true;
    await interaction.reply(createV2EphemeralError('Tu n’as pas le rôle nécessaire pour utiliser cette commande.'));
    return false;
  }

  async function recordCase(discordId, type, interaction, reason) {
    await pool.execute(
      `INSERT INTO ${CASE_TABLE} (discord_id, type, moderator_discord_id, raison) VALUES (?, ?, ?, ?)`,
      [discordId, type, interaction.user.id, reason],
    );
  }

  function formatRemainingTimeout(timestamp) {
    const remainingMs = Math.max(0, timestamp - Date.now());
    const totalSeconds = Math.ceil(remainingMs / 1000);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (days) parts.push(`${days} jour${days > 1 ? 's' : ''}`);
    if (hours) parts.push(`${hours} heure${hours > 1 ? 's' : ''}`);
    if (minutes) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
    if (!parts.length || seconds) parts.push(`${seconds} seconde${seconds > 1 ? 's' : ''}`);
    return parts.join(', ');
  }

  async function handleStrike(interaction) {
    if (!(await ensureModerationAccess(interaction))) return;
    await interaction.deferReply();
    if (!(await ensureDatabase(interaction))) return;
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison', true).trim();
    try {
      await pool.execute(
        `INSERT INTO ${STRIKE_TABLE} (discord_id, moderator_discord_id, raison) VALUES (?, ?, ?)`,
        [target.id, interaction.user.id, reason],
      );
      try {
        await target.send(createV2Message({
          title: 'Un avertissement vous a été attribué',
          description: `Un avertissement a été enregistré sur votre compte.\n**Modérateur :** ${moderatorLabel(interaction)}`,
          sections: [`**Raison :** ${reason}`],
        }));
      } catch (error) {
        console.error(`[Moderation] Unable to DM strike target ${target.id}:`, error.message);
      }
      await safeEditReply(interaction, createV2Message({
        title: 'Avertissement attribué',
        description: `${target} a reçu un avertissement.\n**Modérateur :** ${moderatorLabel(interaction)}`,
        sections: [`**Raison :** ${reason}`],
      }));
      await sendLog('AVERTISSEMENT', `${target} a reçu un avertissement.`, [
        logField('Cible', `${target} (${target.id})`),
        logField('Modérateur', moderatorLabel(interaction)),
        logField('Raison', reason),
      ]);
    } catch (error) {
      console.error('[Moderation] Unable to create warning:', error.message);
      await safeEditReply(interaction, createV2Message({
        title: 'Échec de l’avertissement',
        description: 'Impossible d’enregistrer l’avertissement en base de données.',
      }));
    }
  }

  async function handleTimeout(interaction) {
    if (!(await ensureModerationAccess(interaction))) return;
    await interaction.deferReply();
    if (!(await ensureDatabase(interaction))) return;
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison', true).trim();
    const duration = parseTimeoutDuration(interaction.options.getString('duree', true));
    if (!duration) {
      await safeEditReply(interaction, createV2Message({
        title: 'Durée invalide',
        description: 'Utilise un nombre suivi de `m`, `h` ou `d`, par exemple `30m`, `1h` ou `2d` (maximum 28 jours).',
      }));
      return;
    }
    const activeTimeouts = [];
    for (const guild of client.guilds.cache.values()) {
      const member = await guild.members.fetch(target.id).catch(() => null);
      if (member?.communicationDisabledUntilTimestamp > Date.now()) {
        activeTimeouts.push(member.communicationDisabledUntilTimestamp);
      }
    }
    if (activeTimeouts.length) {
      await safeEditReply(interaction, createV2Message({
        title: 'Utilisateur déjà exclu',
        description: `Cet utilisateur est déjà exclu ! Temps restant de sanction : ${formatRemainingTimeout(Math.max(...activeTimeouts))}`,
      }));
      return;
    }
    let succeeded = 0;
    let failed = 0;
    for (const guild of client.guilds.cache.values()) {
      try {
        const member = await guild.members.fetch(target.id).catch(() => null);
        if (!member) continue;
        await member.timeout(duration.milliseconds, reason);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        console.error(`[Moderation] Timeout failed in ${guild.name} (${guild.id}):`, error.message);
      }
    }
    if (succeeded > 0) {
      try {
        await target.send(createV2Message({
          title: 'Vous avez reçu une exclusion temporaire',
          description: `Vous êtes exclu pour ${duration.label}.\n**Modérateur :** ${moderatorLabel(interaction)}`,
          sections: [`**Raison :** ${reason}`],
        }));
      } catch (error) {
        console.error(`[Moderation] Unable to DM timeout target ${target.id}:`, error.message);
      }
    }
    await safeEditReply(interaction, createV2Message({
      title: 'Exclusion appliquée',
      description: `${target} est exclu pour ${duration.label}.\n**Modérateur :** ${moderatorLabel(interaction)}`,
      sections: [`**Raison :** ${reason}`],
    }));
    await recordCase(target.id, 'exclusion', interaction, reason);
    await sendLog('EXCLUSION', `${target} est exclu pour ${duration.label}.`, [
      logField('Modérateur', moderatorLabel(interaction)),
      logField('Raison', reason),
      logField('Résultat', `Réussi sur ${succeeded} serveur(s), échoué sur ${failed}`, true),
    ]);
  }

  async function handleGlobalBan(interaction) {
    if (!(await ensureModerationAccess(interaction))) return;
    await interaction.deferReply();
    if (!(await ensureDatabase(interaction))) return;
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison', true).trim();
    const targetGuilds = [];
    for (const guild of client.guilds.cache.values()) {
      const member = await guild.members.fetch(target.id).catch(() => null);
      if (member) targetGuilds.push({ guild, member });
    }

    try {
      await target.send(createV2Message({
        title: 'Vous avez été banni !',
        description: 'Votre bannissement va être appliqué sur les serveurs suivants :',
        sections: [
          `**Serveur${targetGuilds.length > 1 ? 's' : ''} concerné${targetGuilds.length > 1 ? 's' : ''} :**\n${targetGuilds.length ? targetGuilds.map(({ guild }) => guild.name).join('\n') : 'Aucun serveur trouvé.'}`,
          `**Raison :** ${reason}`,
          `**Modérateur :** ${moderatorLabel(interaction)}`,
        ],
      }));
    } catch (error) {
      console.error(`[Moderation] Unable to DM ban target ${target.id} before actions:`, error.message);
    }

    let succeeded = 0;
    let failed = 0;
    const bannedServers = [];
    for (const { guild } of targetGuilds) {
      try {
        await guild.members.ban(target.id, { reason });
        succeeded += 1;
        bannedServers.push(guild.name);
        await pool.execute(
          `INSERT INTO ${BAN_TABLE} (discord_id, guild_id, guild_name) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE guild_name = VALUES(guild_name), banned_at = CURRENT_TIMESTAMP`,
          [target.id, guild.id, guild.name],
        );
      } catch (error) {
        failed += 1;
        console.error(`[Moderation] Ban failed in ${guild.name} (${guild.id}):`, error.message);
      }
    }
    await recordCase(target.id, 'bannissement', interaction, reason);
    await safeEditReply(interaction, createV2Message({
      title: 'Bannissement global appliqué',
      description: `${target} a été banni de la communauté.\n**Modérateur :** ${moderatorLabel(interaction)}`,
      sections: [`**Raison :** ${reason}`],
    }));
    await sendLog('BAN GLOBAL', `${target} a été banni de la communauté.`, [
      logField('Cible', `${target} (${target.id})`),
      logField('Modérateur', moderatorLabel(interaction)),
      logField('Raison', reason),
      logField('Résultat', `${succeeded} réussi(s), ${failed} échec(s)`, true),
    ]);
  }

  async function handleUntimeout(interaction) {
    if (!(await ensureModerationAccess(interaction))) return;
    await interaction.deferReply();
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison')?.trim() || 'Retrait de l’exclusion';
    let succeeded = 0;
    let failed = 0;
    for (const guild of client.guilds.cache.values()) {
      try {
        const member = await guild.members.fetch(target.id).catch(() => null);
        if (!member) continue;
        await member.timeout(null, reason);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        console.error(`[Moderation] End exclusion failed in ${guild.name} (${guild.id}):`, error.message);
      }
    }
    await safeEditReply(interaction, createV2Message({
      title: 'Exclusion retirée',
      description: `L’exclusion de ${target} a été retirée partout où cela était possible.\n**Modérateur :** ${moderatorLabel(interaction)}`,
      sections: [`**Raison :** ${reason}`],
    }));
    await sendLog('FIN D’EXCLUSION', `${target} n’est plus exclu.`, [
      logField('Cible', `${target} (${target.id})`),
      logField('Modérateur', moderatorLabel(interaction)),
      logField('Raison', reason),
      logField('Résultat', `${succeeded} réussi(s), ${failed} échec(s)`, true),
    ]);
  }

  async function handleExpulsion(interaction) {
    if (!(await ensureModerationAccess(interaction))) return;
    await interaction.deferReply();
    if (!(await ensureDatabase(interaction))) return;
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison', true).trim();
    let succeeded = 0;
    let failed = 0;
    for (const guild of client.guilds.cache.values()) {
      try {
        const member = await guild.members.fetch(target.id).catch(() => null);
        if (!member) continue;
        await member.kick(reason);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        console.error(`[Moderation] Kick failed in ${guild.name} (${guild.id}):`, error.message);
      }
    }
    await recordCase(target.id, 'expulsion', interaction, reason);
    await safeEditReply(interaction, createV2Message({
      title: 'Expulsion appliquée',
      description: `${target} a été expulsé de ${succeeded} serveur(s).\n**Modérateur :** ${moderatorLabel(interaction)}`,
      sections: [`**Raison :** ${reason}`, `**Résultat :** ${succeeded} réussi(s), ${failed} échec(s)`],
    }));
    await sendLog('EXPULSION', `${target} a été expulsé de tous les serveurs possibles.`, [
      logField('Cible', `${target} (${target.id})`),
      logField('Modérateur', moderatorLabel(interaction)),
      logField('Raison', reason),
      logField('Résultat', `${succeeded} réussi(s), ${failed} échec(s)`, true),
    ]);
  }

  async function handleRemoveWarning(interaction) {
    if (!(await ensureModerationAccess(interaction))) return;
    await interaction.deferReply();
    if (!(await ensureDatabase(interaction))) return;
    const target = interaction.options.getUser('utilisateur', true);
    const warningId = interaction.options.getInteger('avertissement', true);
    const reason = interaction.options.getString('raison')?.trim() || 'Retrait de l’avertissement';
    try {
      const [result] = await pool.execute(
        `DELETE FROM ${STRIKE_TABLE} WHERE id = ? AND discord_id = ?`,
        [warningId, target.id],
      );
      await safeEditReply(interaction, createV2Message({
        title: result.affectedRows ? 'Avertissement retiré' : 'Avertissement introuvable',
        description: result.affectedRows
          ? `L’avertissement n°${warningId} de ${target} a été retiré.`
          : `L’avertissement n°${warningId} n’existe pas pour ${target}.`,
        sections: [`**Raison :** ${reason}`],
      }));
      if (result.affectedRows) {
        await sendLog('AVERTISSEMENT RETIRÉ', `L’avertissement n°${warningId} de ${target} a été retiré.`, [
          logField('Cible', `${target} (${target.id})`),
          logField('Modérateur', moderatorLabel(interaction)),
          logField('Raison', reason),
        ]);
      }
    } catch (error) {
      console.error('[Moderation] Unable to remove warning:', error.message);
      await safeEditReply(interaction, createV2Message({
        title: 'Échec du retrait',
        description: 'Impossible de retirer cet avertissement.',
      }));
    }
  }

  async function handleUnban(interaction) {
    if (!(await ensureModerationAccess(interaction))) return;
    await interaction.deferReply();
    if (!(await ensureDatabase(interaction))) return;
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison')?.trim() || 'Retrait du bannissement';
    const [storedBans] = await pool.execute(
      `SELECT guild_id, guild_name FROM ${BAN_TABLE} WHERE discord_id = ? ORDER BY banned_at ASC`,
      [target.id],
    );
    console.info(`[Moderation] Stored bans for ${target.id}:`, storedBans.map(b => `${b.guild_name} (${b.guild_id})`).join(', '));
    let succeeded = 0;
    let failed = 0;
    for (const ban of storedBans) {
      const guild = client.guilds.cache.get(ban.guild_id);
      if (!guild) {
        console.warn(`[Moderation] Guild ${ban.guild_id} not cached, skipping unban for ${target.id}`);
        continue;
      }
      try {
        await guild.bans.remove(target.id, reason);
        succeeded += 1;
        console.info(`[Moderation] Unbanned ${target.id} from ${guild.name} (${guild.id})`);
      } catch (error) {
        failed += 1;
        console.error(`[Moderation] Unban failed in ${guild.name} (${guild.id}):`, error.message);
      }
    }
    try {
      if (storedBans.length) {
        await target.send(createV2Message({
          title: 'Vous avez été débanni !',
          description: 'Votre bannissement a été retiré sur les serveurs suivants :',
          sections: [storedBans.map((ban) => ban.guild_name).join('\n')],
        }));
      }
    } catch (error) {
      console.error(`[Moderation] Unable to DM unban target ${target.id}:`, error.message);
    }
    await pool.execute(`DELETE FROM ${BAN_TABLE} WHERE discord_id = ?`, [target.id]);
    await safeEditReply(interaction, createV2Message({
      title: 'Bannissement retiré',
      description: `Le bannissement de ${target} a été retiré partout où cela était possible.\n**Modérateur :** ${moderatorLabel(interaction)}`,
      sections: [`**Raison :** ${reason}`],
    }));
    await sendLog('BANNISSEMENT RETIRÉ', `${target} n’est plus banni.`, [
      logField('Cible', `${target} (${target.id})`),
      logField('Modérateur', moderatorLabel(interaction)),
      logField('Raison', reason),
      logField('Résultat', `${succeeded} réussi(s), ${failed} échec(s)`, true),
    ]);
  }

  async function handlePurgeWarnings(interaction) {
    if (!(await ensureModerationAccess(interaction))) return;
    await interaction.deferReply();
    if (!(await ensureDatabase(interaction))) return;
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison')?.trim() || 'Purge des avertissements';
    try {
      const [result] = await pool.execute(`DELETE FROM ${STRIKE_TABLE} WHERE discord_id = ?`, [target.id]);
      await safeEditReply(interaction, createV2Message({
        title: 'Avertissements purgés',
        description: `Les avertissements de ${target} ont été supprimés (${result.affectedRows} supprimé(s)).\n**Modérateur :** ${moderatorLabel(interaction)}`,
        sections: [`**Raison :** ${reason}`],
      }));
      await sendLog('AVERTISSEMENTS PURGÉS', `${result.affectedRows} avertissement(s) supprimé(s) pour ${target}.`, [
        logField('Cible', `${target} (${target.id})`),
        logField('Modérateur', `${interaction.user} (${interaction.user.id})`),
        logField('Raison', reason),
        logField('Nombre supprimé', result.affectedRows, true),
      ]);
    } catch (error) {
      console.error('[Moderation] Unable to purge warnings:', error.message);
      await safeEditReply(interaction, createV2Message({
        title: 'Échec de la purge',
        description: 'Impossible de supprimer les avertissements.',
      }));
    }
  }

  async function handlePurgeCaseFile(interaction) {
    if (!(await ensureModerationAccess(interaction))) return;
    await interaction.deferReply();
    if (!(await ensureDatabase(interaction))) return;
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison')?.trim() || 'Purge complète du casier de modération';
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [warningResult] = await connection.execute(`DELETE FROM ${STRIKE_TABLE} WHERE discord_id = ?`, [target.id]);
      const [caseResult] = await connection.execute(`DELETE FROM ${CASE_TABLE} WHERE discord_id = ?`, [target.id]);
      const [banResult] = await connection.execute(`DELETE FROM ${BAN_TABLE} WHERE discord_id = ?`, [target.id]);
      await connection.commit();

      const deletedCount = warningResult.affectedRows + caseResult.affectedRows + banResult.affectedRows;
      await safeEditReply(interaction, createV2Message({
        title: 'Casier de modération purgé',
        description: `Le casier de modération de ${target} a été entièrement purgé.`,
        sections: [
          `**Éléments supprimés :** ${deletedCount}`,
          `**Raison :** ${reason}`,
        ],
      }));
      await sendLog('CASIER PURGÉ', `Le casier de modération de ${target} a été entièrement purgé.`, [
        logField('Cible', `${target} (${target.id})`),
        logField('Modérateur', moderatorLabel(interaction)),
        logField('Raison', reason),
        logField('Éléments supprimés', deletedCount, true),
      ]);
    } catch (error) {
      await connection.rollback();
      console.error('[Moderation] Unable to purge case file:', error.message);
      await safeEditReply(interaction, createV2Message({
        title: 'Échec de la purge',
        description: 'Impossible de purger entièrement le casier de modération.',
      }));
    } finally {
      connection.release();
    }
  }

  async function handleCaseFileView(interaction, explicitTargetId = null) {
    let targetId = explicitTargetId;
    if (!targetId) {
      const discordField = interaction.message?.embeds?.[0]?.fields?.find((field) => field.name === 'Discord')?.value;
      targetId = discordField?.match(/<@!?([0-9]+)>/)?.[1];
    }
    if (!targetId || !(await initializeDatabase())) {
      await interaction.reply(createV2EphemeralError('Impossible de récupérer le casier de modération.'));
      return;
    }
    const [warnings] = await pool.execute(
      `SELECT id, moderator_discord_id, raison,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at_utc
       FROM ${STRIKE_TABLE} WHERE discord_id = ? ORDER BY created_at DESC`,
      [targetId],
    );
    const [cases] = await pool.execute(
      `SELECT type, moderator_discord_id, raison,
              DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%sZ') AS created_at_utc
       FROM ${CASE_TABLE} WHERE discord_id = ? ORDER BY created_at DESC`,
      [targetId],
    );
    if (!warnings.length && !cases.length) {
      await interaction.reply({
        ...createV2Message({
          title: 'Casier de modération',
          description: 'Aucun avertissement ni autre sanction enregistré pour cet utilisateur.',
          ephemeral: true,
        }),
      });
      return;
    }
    const warningSections = warnings.map((warning) => {
      const timestamp = Math.floor(new Date(warning.created_at_utc).getTime() / 1000);
      return `**Avertissement n°${warning.id} | <t:${timestamp}:F>**\n**Raison :** ${warning.raison}\n**Modérateur :** <@${warning.moderator_discord_id}>`;
    });
    const caseSections = cases.map((caseItem) => {
      const timestamp = Math.floor(new Date(caseItem.created_at_utc).getTime() / 1000);
      const labels = { bannissement: 'Bannissement', exclusion: 'Exclusion', expulsion: 'Expulsion' };
      return `**${labels[caseItem.type] ?? caseItem.type} | <t:${timestamp}:F>**\n**Raison :** ${caseItem.raison}\n**Modérateur :** <@${caseItem.moderator_discord_id}>`;
    });
    const sections = [...warningSections, ...caseSections];

    await interaction.reply({
      ...createV2Message({
        title: 'Casier de modération',
        description: sections[0],
        sections: sections.slice(1),
        ephemeral: true,
      }),
    });
  }

  async function handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId.startsWith('moderation_casefile')) {
      const targetId = interaction.customId.includes(':') ? interaction.customId.split(':')[1] : null;
      await handleCaseFileView(interaction, targetId);
      return true;
    }
    if (!interaction.isChatInputCommand()) return false;
    if (interaction.commandName === 'avertissement') await handleStrike(interaction);
    else if (interaction.commandName === 'exclusion') await handleTimeout(interaction);
    else if (interaction.commandName === 'bannissement-global') await handleGlobalBan(interaction);
    else if (interaction.commandName === 'fin-exclusion') await handleUntimeout(interaction);
    else if (interaction.commandName === 'fin-bannissement') await handleUnban(interaction);
    else if (interaction.commandName === 'purgeavertissement') await handlePurgeWarnings(interaction);
    else if (interaction.commandName === 'purgecasier') await handlePurgeCaseFile(interaction);
    else if (interaction.commandName === 'retireravertissement') await handleRemoveWarning(interaction);
    else if (interaction.commandName === 'expulsion') await handleExpulsion(interaction);
    else return false;
    return true;
  }

  return { initializeDatabase, handleInteraction };
}