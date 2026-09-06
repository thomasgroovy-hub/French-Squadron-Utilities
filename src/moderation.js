import mysql from 'mysql2/promise';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
} from 'discord.js';

const MODERATION_GUILD_ID = '1487258655840669807';
const LOG_CHANNEL_ID = '1546193398388494336';
const MODERATION_ROLE_ID = '1487266203864006707';
const UNLINK_ROLE_ID = '1487276505712033883';
const STRIKE_TABLE = 'strikes';
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

export const moderationCommands = [
  new SlashCommandBuilder()
    .setName('strikes')
    .setDescription('Attribue un strike à un utilisateur.')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addStringOption((option) => option.setName('raison').setDescription('Raison du strike').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Place un utilisateur en timeout sur tous les serveurs.')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addStringOption((option) => option.setName('raison').setDescription('Raison du timeout').setRequired(true).setMaxLength(1000))
    .addStringOption((option) => option
      .setName('duree')
      .setDescription('Durée : 30m, 1h ou 2d (maximum 28 jours)')
      .setRequired(true)
      .setMaxLength(10)),
  new SlashCommandBuilder()
    .setName('globalban')
    .setDescription('Bannit un utilisateur sur tous les serveurs.')
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur ciblé').setRequired(true))
    .addStringOption((option) => option.setName('raison').setDescription('Raison du bannissement').setRequired(true).setMaxLength(1000)),
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
    const guild = client.guilds.cache.get(MODERATION_GUILD_ID);
    const member = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null;
    const role = guild?.roles.cache.get(MODERATION_ROLE_ID);
    return Boolean(role && member?.roles.highest && member.roles.highest.position >= role.position);
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

  async function sendLog(title, color, fields) {
    try {
      const channel = await client.channels.fetch(LOG_CHANNEL_ID);
      if (!channel?.isTextBased() || !channel.isSendable() || channel.guildId !== MODERATION_GUILD_ID) {
        throw new Error(`Log channel ${LOG_CHANNEL_ID} is unavailable.`);
      }
      await channel.send({
        embeds: [new EmbedBuilder().setColor(color).setTitle(title).addFields(fields).setTimestamp()],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      console.error('[Moderation] Unable to send log:', error.message);
    }
  }

  async function requireDatabase(interaction) {
    if (await initializeDatabase()) return true;
    await interaction.reply({ content: 'Le système de modération est temporairement indisponible.', ephemeral: true });
    return false;
  }

  async function handleStrike(interaction) {
    if (!(await hasModerationAccess(interaction))) {
      await interaction.reply({ content: 'Tu n’as pas le rôle nécessaire pour utiliser cette commande.', ephemeral: true });
      return;
    }
    if (!(await requireDatabase(interaction))) return;
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison', true).trim();
    try {
      await pool.execute(
        `INSERT INTO ${STRIKE_TABLE} (discord_id, moderator_discord_id, raison) VALUES (?, ?, ?)`,
        [target.id, interaction.user.id, reason],
      );
      try {
        await target.send(`Tu as reçu un strike.\nRaison : ${reason}\nModérateur : ${interaction.user.tag}`);
      } catch (error) {
        console.error(`[Moderation] Unable to DM strike target ${target.id}:`, error.message);
      }
      await interaction.reply({ content: `Le strike de ${target} a été enregistré.`, ephemeral: true });
      await sendLog('Strike attribué', 0xF1C40F, [
        logField('Cible', `${target} (${target.id})`),
        logField('Modérateur', `${interaction.user} (${interaction.user.id})`),
        logField('Raison', reason),
      ]);
    } catch (error) {
      console.error('[Moderation] Unable to create strike:', error.message);
      await interaction.reply({ content: 'Impossible d’enregistrer le strike.', ephemeral: true }).catch(() => {});
    }
  }

  async function handleTimeout(interaction) {
    if (!(await hasModerationAccess(interaction))) {
      await interaction.reply({ content: 'Tu n’as pas le rôle nécessaire pour utiliser cette commande.', ephemeral: true });
      return;
    }
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison', true).trim();
    const duration = parseTimeoutDuration(interaction.options.getString('duree', true));
    if (!duration) {
      await interaction.reply({ content: 'Durée invalide. Utilise un nombre suivi de `m`, `h` ou `d`, par exemple `30m`, `1h` ou `2d` (maximum 28 jours).', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
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
    await interaction.editReply(`Timeout de ${duration.label} appliqué à ${target} sur ${succeeded} serveur(s). Échecs : ${failed}.`);
    await sendLog('Timeout appliqué', 0xE67E22, [
      logField('Cible', `${target} (${target.id})`),
      logField('Modérateur', `${interaction.user} (${interaction.user.id})`),
      logField('Raison', reason),
      logField('Durée', duration.label, true),
      logField('Résultat', `${succeeded} réussi(s), ${failed} échec(s)`, true),
    ]);
  }

  async function handleGlobalBan(interaction) {
    if (!(await hasModerationAccess(interaction))) {
      await interaction.reply({ content: 'Tu n’as pas le rôle nécessaire pour utiliser cette commande.', ephemeral: true });
      return;
    }
    const target = interaction.options.getUser('utilisateur', true);
    const reason = interaction.options.getString('raison', true).trim();
    await interaction.deferReply({ ephemeral: true });
    try {
      await target.send(`Tu as été banni de la communauté.\nRaison : ${reason}\nModérateur : ${interaction.user.tag}`);
    } catch (error) {
      console.error(`[Moderation] Unable to DM ban target ${target.id}:`, error.message);
    }
    let succeeded = 0;
    let failed = 0;
    for (const guild of client.guilds.cache.values()) {
      try {
        await guild.members.ban(target.id, { reason });
        succeeded += 1;
      } catch (error) {
        failed += 1;
        console.error(`[Moderation] Ban failed in ${guild.name} (${guild.id}):`, error.message);
      }
    }
    await interaction.editReply(`Bannissement global effectué sur ${succeeded} serveur(s). Échecs : ${failed}.`);
    await sendLog('Bannissement global', 0xE74C3C, [
      logField('Cible', `${target} (${target.id})`),
      logField('Modérateur', `${interaction.user} (${interaction.user.id})`),
      logField('Raison', reason),
      logField('Résultat', `${succeeded} réussi(s), ${failed} échec(s)`, true),
    ]);
  }

  async function handleStrikesView(interaction) {
    const discordField = interaction.message.embeds[0]?.fields?.find((field) => field.name === 'Discord')?.value;
    const targetId = discordField?.match(/<@!?([0-9]+)>/)?.[1];
    if (!targetId || !(await initializeDatabase())) {
      await interaction.reply({ content: 'Impossible de récupérer les strikes.', ephemeral: true });
      return;
    }
    const [strikes] = await pool.execute(
      `SELECT moderator_discord_id, raison, created_at FROM ${STRIKE_TABLE} WHERE discord_id = ? ORDER BY created_at DESC`,
      [targetId],
    );
    if (!strikes.length) {
      await interaction.reply({ content: 'Aucun strike enregistré.', ephemeral: true });
      return;
    }
    const description = strikes.map((strike, index) => {
      const date = new Date(strike.created_at).toLocaleString('fr-FR');
      return `**${index + 1}. ${date}**\nRaison : ${strike.raison}\nModérateur : <@${strike.moderator_discord_id}>`;
    }).join('\n\n');
    await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xF1C40F).setTitle('Strikes enregistrés').setDescription(description)], ephemeral: true });
  }

  async function handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId === 'strikes_view') {
      await handleStrikesView(interaction);
      return true;
    }
    if (!interaction.isChatInputCommand() || interaction.guildId !== MODERATION_GUILD_ID) return false;
    if (interaction.commandName === 'strikes') await handleStrike(interaction);
    else if (interaction.commandName === 'timeout') await handleTimeout(interaction);
    else if (interaction.commandName === 'globalban') await handleGlobalBan(interaction);
    else return false;
    return true;
  }

  return { initializeDatabase, handleInteraction };
}