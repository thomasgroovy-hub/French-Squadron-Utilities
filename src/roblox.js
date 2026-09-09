import express from 'express';
import mysql from 'mysql2/promise';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { createV2EphemeralError, createV2Message } from './components.js';
import { SUPER_ADMIN_ROLE_ID, hasGuildPermission } from './permissions.js';

const IDS = {
  verificationGuild: '1487258655840669807',
  commandGuild: '1454217001626243288',
  verificationPanelRole: '1518410191933014057',
  unlinkRole: '1487276505712033883',
  verifiedRole: '1534186084097851474',
  completedVerificationRole: '1545975768104968272',
  developmentRole: '1545976696312696873',
  loreRole: '1545976671369433218',
  sessionsRole: '1545976696312696873',
  logChannel: '1546193398388494336',
};

const ROBLOX = {
  lookup: 'https://users.roblox.com/v1/usernames/users',
  user: 'https://users.roblox.com/v1/users/',
};
const MODERATION_CASE_TABLE = 'moderation_cases';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CACHE_TTL = 5 * 60 * 1000;
const EMBED_COLOR = 0x2B2D31;

export const robloxCommands = [
  new SlashCommandBuilder().setName('verification-panel').setDescription('Poste le panneau de vérification Roblox.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName('who-is').setDescription('Recherche la liaison Discord ou Roblox d’une personne.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) => option.setName('discord').setDescription('Membre Discord à rechercher'))
    .addStringOption((option) => option.setName('roblox').setDescription('Pseudo Roblox à rechercher').setMaxLength(20)),
  new SlashCommandBuilder().setName('unlink').setDescription('Détache le compte Roblox d’un utilisateur.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption((option) => option.setName('utilisateur').setDescription('Utilisateur à délier').setRequired(true)),
  new SlashCommandBuilder().setName('panel-role').setDescription('Poste le panneau des rôles de notifications.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
];

class RobloxApiError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}

function createPool() {
  const required = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`[Roblox] MySQL disabled; missing ${missing.join(', ')}.`);
    return null;
  }
  const port = Number.parseInt(process.env.MYSQL_PORT || '3306', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MYSQL_PORT must be between 1 and 65535.');
  return mysql.createPool({
    host: process.env.MYSQL_HOST,
    port,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 3,
    queueLimit: 0,
    connectTimeout: 10_000,
  });
}

function eventSecret() {
  const raw = process.env.ROBLOX_EVENT_SECRET || process.env.PERMADEATH_BOT_API_KEY;
  return raw?.trim().replace(/^Bearer\s+/i, '').trim() || null;
}

function tokenFrom(request) {
  const match = request.get('authorization')?.trim().match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function tokensMatch(received, expected) {
  if (!received || !expected) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fingerprint(value) {
  return value ? `${value.length}:${createHash('sha256').update(value).digest('hex').slice(0, 12)}` : 'missing';
}

function portFromEnvironment() {
  const port = Number.parseInt(process.env.PORT || '8080', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  return port;
}

function validDeathPayload(body) {
  return Boolean(
    body && typeof body.eventId === 'string' && body.eventId.length > 0 && body.eventId.length <= 100
    && body.eventType === 'permadeath_death'
    && Number.isSafeInteger(body.occurredAt) && body.occurredAt > 0
    && Number.isSafeInteger(body.robloxUserId) && body.robloxUserId > 0
    && typeof body.robloxUsername === 'string' && body.robloxUsername.length > 0 && body.robloxUsername.length <= 20
    && typeof body.robloxDisplayName === 'string',
  );
}

async function robloxJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new RobloxApiError('network', error.name === 'TimeoutError' ? 'Roblox ne répond pas à temps.' : 'Roblox est inaccessible.');
  }
  if (response.status === 429) throw new RobloxApiError('rateLimit', 'Roblox limite temporairement les requêtes.');
  if (response.status === 404) throw new RobloxApiError('notFound', 'Compte Roblox introuvable.');
  if (!response.ok) throw new RobloxApiError('network', `Roblox a répondu HTTP ${response.status}.`);
  try { return await response.json(); } catch { throw new RobloxApiError('network', 'Roblox a envoyé une réponse invalide.'); }
}

const userCache = new Map();
const profileCache = new Map();

async function findRobloxUser(username) {
  const key = username.toLowerCase();
  const cached = userCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;
  const data = await robloxJson(ROBLOX.lookup, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
  });
  const user = data.data?.[0];
  if (!user?.id || !user.name) throw new RobloxApiError('notFound', 'Ce pseudo Roblox est introuvable.');
  const value = { id: user.id, username: user.name };
  userCache.set(key, { value, expires: Date.now() + CACHE_TTL });
  return value;
}

async function getRobloxProfile(userId) {
  const cached = profileCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.value;
  const user = await robloxJson(`${ROBLOX.user}${userId}`);
  if (!user?.id || !user.name) throw new RobloxApiError('notFound', 'Ce compte Roblox n’existe plus.');
  const value = { id: user.id, username: user.name, displayName: user.displayName || user.name, description: user.description || '', created: user.created || null };
  profileCache.set(userId, { value, expires: Date.now() + CACHE_TTL });
  return value;
}

function robloxError(error) {
  if (error instanceof RobloxApiError) {
    if (error.kind === 'notFound') return 'Compte Roblox introuvable.';
    if (error.kind === 'rateLimit') return 'Roblox limite temporairement les vérifications.';
    return 'Impossible de joindre Roblox pour le moment.';
  }
  return 'Une erreur inattendue est survenue.';
}

function makeCode() {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
}

function deathMessage(payload) {
  return createV2Message({
    title: 'NOTIFICATION DE MORT',
    description: 'Tu es mort durant une session roleplay.',
    sections: [`**Personnage :** ${payload.robloxUsername}\nTon personnage est désormais mort de manière roleplay. Si tu trouves cette mort injuste, ouvre un **ticket** afin de la contester.`, '*L’équipe lore de Site-66.*'],
    accentColor: EMBED_COLOR,
  });
}

export function createRobloxIntegration({ client, guildId }) {
  const pool = createPool();
  const app = express();
  let server = null;
  let databaseReady = false;
  let databasePromise = null;
  let lastDatabaseAttempt = 0;

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use((error, _request, response, next) => {
    if (error instanceof SyntaxError && 'body' in error) { response.status(400).json({ error: 'Invalid JSON body.' }); return; }
    next(error);
  });
  app.get('/health', (_request, response) => response.status(200).json({ ok: true, service: 'roblox-webhook' }));

  async function initializeDatabase({ force = false } = {}) {
    if (!pool) return false;
    if (databaseReady) return true;
    if (databasePromise) return databasePromise;
    if (!force && Date.now() - lastDatabaseAttempt < 60_000) return false;
    lastDatabaseAttempt = Date.now();
    databasePromise = (async () => {
      try {
        await pool.query(`CREATE TABLE IF NOT EXISTS roblox_discord_links (discord_user_id VARCHAR(20) NOT NULL PRIMARY KEY, roblox_user_id BIGINT UNSIGNED NOT NULL UNIQUE, roblox_username VARCHAR(20) NOT NULL, verification_rank BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE, verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        const [columns] = await pool.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'roblox_discord_links' AND COLUMN_NAME = 'verification_rank'`);
        if (!columns.length) await pool.query('ALTER TABLE roblox_discord_links ADD COLUMN verification_rank BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE AFTER discord_user_id');
        await pool.query(`CREATE TABLE IF NOT EXISTS roblox_pending_links (discord_user_id VARCHAR(20) NOT NULL PRIMARY KEY, roblox_user_id BIGINT UNSIGNED NOT NULL UNIQUE, roblox_username VARCHAR(20) NOT NULL, verification_code CHAR(6) NOT NULL UNIQUE, expires_at DATETIME NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        await pool.query(`CREATE TABLE IF NOT EXISTS roblox_processed_death_events (event_id VARCHAR(100) NOT NULL PRIMARY KEY, received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        await pool.query(`CREATE TABLE IF NOT EXISTS strikes (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, discord_id VARCHAR(20) NOT NULL, moderator_discord_id VARCHAR(20) NOT NULL, raison VARCHAR(1000) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX strikes_discord_id_idx (discord_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        await pool.query(`CREATE TABLE IF NOT EXISTS ${MODERATION_CASE_TABLE} (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, discord_id VARCHAR(20) NOT NULL, type VARCHAR(32) NOT NULL, moderator_discord_id VARCHAR(20) NOT NULL, raison VARCHAR(1000) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX moderation_cases_discord_id_idx (discord_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
        databaseReady = true;
        console.log('[Roblox] Database ready.');
        return true;
      } catch (error) {
        databaseReady = false;
        console.error('[Roblox] Database initialization failed:', error.message);
        return false;
      } finally { databasePromise = null; }
    })();
    return databasePromise;
  }

  function databaseError(error) { databaseReady = false; console.error('[Roblox] Database operation failed:', error.message); }
  async function hasAccess(interaction, roles, permission) {
    return hasGuildPermission({ client, guildId: IDS.verificationGuild, userId: interaction.user.id, requiredPermission: permission, allowedRoleIds: roles });
  }
  async function logEvent(interaction, message) {
    try {
      const channel = await client.channels.fetch(IDS.logChannel);
      if (channel?.isTextBased() && channel.isSendable()) await channel.send({ content: `**Discord :** ${interaction.user} (${interaction.user.id})\n${message}`, allowedMentions: { parse: [] } });
    } catch (error) { console.error('[Roblox] Log failed:', error.message); }
  }

  async function verificationPanel(interaction) {
    if (!await hasAccess(interaction, [IDS.verificationPanelRole, SUPER_ADMIN_ROLE_ID], PermissionFlagsBits.ManageGuild)) { await interaction.reply(createV2EphemeralError('Tu n’as pas le rôle nécessaire pour poster le panneau.')); return; }
    await interaction.reply(createV2Message({ title: 'Vérifie ton Roblox', description: 'Inscris ton pseudo Roblox puis place le code fourni dans ta bio Roblox.', actionRow: new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify_panel_start').setLabel('Se vérifier').setStyle(ButtonStyle.Primary)), accentColor: EMBED_COLOR }));
  }

  async function verificationStart(interaction) {
    if (!await initializeDatabase()) { await interaction.reply(createV2EphemeralError('La base de données est temporairement indisponible.')); return; }
    try {
      const [rows] = await pool.execute('SELECT roblox_username FROM roblox_discord_links WHERE discord_user_id = ? LIMIT 1', [interaction.user.id]);
      if (rows[0]) { await interaction.reply(createV2EphemeralError(`Tu es déjà vérifié avec **${rows[0].roblox_username}**.`, 'Déjà vérifié')); return; }
      const modal = new ModalBuilder().setCustomId('verify_panel_username').setTitle('Vérifie ton Roblox');
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('roblox_username').setLabel('Pseudo Roblox').setPlaceholder('Ton nom d’utilisateur Roblox').setStyle(TextInputStyle.Short).setRequired(true).setMinLength(3).setMaxLength(20)));
      await interaction.showModal(modal);
    } catch (error) { databaseError(error); await interaction.reply(createV2EphemeralError('Impossible de démarrer la vérification.')).catch(() => {}); }
  }

  async function verificationUsername(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!await initializeDatabase()) { await interaction.editReply('La base de données est temporairement indisponible.'); return; }
    try {
      const user = await findRobloxUser(interaction.fields.getTextInputValue('roblox_username').trim());
      const [linked] = await pool.execute('SELECT discord_user_id FROM roblox_discord_links WHERE roblox_user_id = ? LIMIT 1', [user.id]);
      if (linked[0] && linked[0].discord_user_id !== interaction.user.id) { await interaction.editReply('Ce compte Roblox est déjà lié à un autre compte Discord.'); return; }
      const [pending] = await pool.execute('SELECT discord_user_id FROM roblox_pending_links WHERE roblox_user_id = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1', [user.id]);
      if (pending[0] && pending[0].discord_user_id !== interaction.user.id) { await interaction.editReply('Une vérification est déjà en cours pour ce compte Roblox.'); return; }
      const code = makeCode();
      await pool.execute('DELETE FROM roblox_pending_links WHERE discord_user_id = ?', [interaction.user.id]);
      await pool.execute('INSERT INTO roblox_pending_links (discord_user_id, roblox_user_id, roblox_username, verification_code, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE))', [interaction.user.id, user.id, user.username, code]);
      await interaction.editReply(createV2Message({ title: 'Code de vérification Roblox', description: `Place ce code dans ta bio Roblox :\n\n\`\`\`\n${code}\n\`\`\``, sections: ['Tu as 15 minutes, puis clique sur **Vérifier mon code**.'], actionRow: new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify_panel_check').setLabel('Vérifier mon code').setStyle(ButtonStyle.Success)), accentColor: EMBED_COLOR }));
      await logEvent(interaction, `Demande créée pour **${user.username}**.`);
    } catch (error) { if (error instanceof RobloxApiError) await interaction.editReply(robloxError(error)); else { databaseError(error); await interaction.editReply('Impossible de créer la demande de vérification.'); } }
  }

  async function updateRole(userId, roleId, remove = false) {
    try {
      const guild = client.guilds.cache.get(IDS.verificationGuild);
      if (!guild) return false;
      const [member, role, botMember] = await Promise.all([guild.members.fetch(userId).catch(() => null), guild.roles.fetch(roleId).catch(() => null), guild.members.fetch(client.user.id)]);
      if (!member || !role || !botMember.permissions.has('ManageRoles') || role.position >= botMember.roles.highest.position) return false;
      if (remove) await member.roles.remove(role); else await member.roles.add(role);
      return true;
    } catch (error) { console.error('[Roblox] Role update failed:', error.message); return false; }
  }

  async function verificationCheck(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!await initializeDatabase()) { await interaction.editReply('La base de données est temporairement indisponible.'); return; }
    try {
      const [rows] = await pool.execute('SELECT roblox_user_id, verification_code, expires_at FROM roblox_pending_links WHERE discord_user_id = ? LIMIT 1', [interaction.user.id]);
      const pending = rows[0];
      if (!pending) { await interaction.editReply('Aucune demande active.'); return; }
      if (new Date(pending.expires_at).getTime() <= Date.now()) { await pool.execute('DELETE FROM roblox_pending_links WHERE discord_user_id = ?', [interaction.user.id]); await interaction.editReply('Le code a expiré.'); return; }
      const profile = await getRobloxProfile(pending.roblox_user_id);
      if (!profile.description.includes(pending.verification_code)) { await interaction.editReply('Le code n’est pas présent dans ta bio Roblox.'); return; }
      const connection = await pool.getConnection();
      let rank;
      try {
        await connection.beginTransaction();
        const [conflict] = await connection.execute('SELECT discord_user_id FROM roblox_discord_links WHERE roblox_user_id = ? FOR UPDATE', [pending.roblox_user_id]);
        if (conflict[0] && conflict[0].discord_user_id !== interaction.user.id) { await connection.rollback(); await interaction.editReply('Ce compte est déjà lié.'); return; }
        await connection.execute('DELETE FROM roblox_discord_links WHERE discord_user_id = ?', [interaction.user.id]);
        const [result] = await connection.execute('INSERT INTO roblox_discord_links (discord_user_id, roblox_user_id, roblox_username) VALUES (?, ?, ?)', [interaction.user.id, pending.roblox_user_id, profile.username]);
        await connection.execute('DELETE FROM roblox_pending_links WHERE discord_user_id = ?', [interaction.user.id]);
        await connection.commit(); rank = result.insertId;
      } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
      const assigned = await updateRole(interaction.user.id, IDS.verifiedRole);
      await updateRole(interaction.user.id, IDS.completedVerificationRole, true);
      await interaction.editReply(createV2Message({ title: 'Vérification réussie', description: `**${profile.username}** est associé à ton compte Discord. Tag : **#${rank}**.`, sections: [assigned ? 'Le rôle vérifié a été attribué.' : 'La liaison est enregistrée, mais le rôle n’a pas pu être attribué.'], accentColor: 0x2ECC71 }));
      await logEvent(interaction, `Liaison confirmée pour **${profile.username}** (#${rank}).`);
    } catch (error) { if (error instanceof RobloxApiError) await interaction.editReply(robloxError(error)); else { databaseError(error); await interaction.editReply('Impossible de vérifier la liaison.'); } }
  }

  async function rolePanel(interaction) {
    if (!await hasAccess(interaction, [IDS.verificationPanelRole, SUPER_ADMIN_ROLE_ID], PermissionFlagsBits.ManageGuild)) { await interaction.reply(createV2EphemeralError('Tu n’as pas le rôle nécessaire.')); return; }
    const buttons = [['role_panel_development', 'Développements'], ['role_panel_lore', 'Lore'], ['role_panel_sessions', 'Sessions']].map(([id, label]) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Secondary));
    await interaction.reply(createV2Message({ title: 'Rôles notifications', description: 'Choisis les notifications que tu souhaites recevoir.', actionRow: new ActionRowBuilder().addComponents(buttons), footer: 'FPCS Utilities', accentColor: EMBED_COLOR }));
  }

  async function roleButton(interaction) {
    const roleId = { role_panel_development: IDS.developmentRole, role_panel_lore: IDS.loreRole, role_panel_sessions: IDS.sessionsRole }[interaction.customId];
    if (!roleId) return false;
    const guild = client.guilds.cache.get(IDS.verificationGuild);
    try {
      const [member, role, botMember] = await Promise.all([guild?.members.fetch(interaction.user.id).catch(() => null), guild?.roles.fetch(roleId).catch(() => null), guild?.members.fetch(client.user.id)]);
      if (!member || !role || !botMember.permissions.has('ManageRoles') || role.position >= botMember.roles.highest.position) { await interaction.reply(createV2EphemeralError('Le bot ne peut pas gérer ce rôle.')); return true; }
      if (member.roles.cache.has(role.id)) { await interaction.reply(createV2Message({ title: 'Rôle déjà attribué', description: 'Tu possèdes déjà ce rôle.', ephemeral: true })); return true; }
      await member.roles.add(role);
      await interaction.reply(createV2Message({ title: 'Rôle attribué', description: `Le rôle **${role.name}** t’a été attribué.`, ephemeral: true }));
    } catch (error) { console.error('[Roblox] Notification role failed:', error.message); await interaction.reply(createV2EphemeralError('Impossible d’attribuer ce rôle.')).catch(() => {}); }
    return true;
  }

  async function unlink(interaction) {
    if (!await hasAccess(interaction, [IDS.unlinkRole, SUPER_ADMIN_ROLE_ID], PermissionFlagsBits.ModerateMembers)) { await interaction.reply(createV2EphemeralError('Tu n’as pas le rôle nécessaire.')); return; }
    const target = interaction.options.getUser('utilisateur', true);
    await interaction.deferReply({ ephemeral: true });
    if (!await initializeDatabase()) { await interaction.editReply('La base de données est temporairement indisponible.'); return; }
    try {
      const [rows] = await pool.execute('SELECT roblox_username FROM roblox_discord_links WHERE discord_user_id = ? LIMIT 1', [target.id]);
      if (!rows[0]) { await interaction.editReply(`Aucun compte Roblox n’est lié à ${target}.`); return; }
      await pool.execute('DELETE FROM roblox_discord_links WHERE discord_user_id = ?', [target.id]);
      await interaction.editReply(`La liaison de ${target} avec **${rows[0].roblox_username}** a été supprimée.`);
    } catch (error) { databaseError(error); await interaction.editReply('Impossible de supprimer la liaison.'); }
  }

  async function whoIs(interaction) {
    const discordUser = interaction.options.getUser('discord');
    const robloxName = interaction.options.getString('roblox')?.trim();
    if (!discordUser && !robloxName) { await interaction.reply(createV2EphemeralError('Renseigne `discord` ou `roblox`.')); return; }
    await interaction.deferReply({ ephemeral: true });
    if (!await initializeDatabase()) { await interaction.editReply('La base de données est temporairement indisponible.'); return; }
    try {
      const [rows] = await pool.execute(discordUser ? 'SELECT discord_user_id, roblox_user_id, roblox_username, verification_rank FROM roblox_discord_links WHERE discord_user_id = ? LIMIT 1' : 'SELECT discord_user_id, roblox_user_id, roblox_username, verification_rank FROM roblox_discord_links WHERE LOWER(roblox_username) = LOWER(?) LIMIT 1', [discordUser?.id || robloxName]);
      const link = rows[0];
      if (!link) { await interaction.editReply(discordUser ? 'Cette personne n’est pas vérifiée.' : 'Aucune liaison ne correspond à ce pseudo.'); return; }
      const [strikes] = await pool.execute('SELECT COUNT(*) AS total FROM strikes WHERE discord_id = ?', [link.discord_user_id]);
      const user = discordUser || await client.users.fetch(link.discord_user_id).catch(() => null);
      const profile = await getRobloxProfile(link.roblox_user_id).catch(() => null);
      await interaction.editReply(createV2Message({ title: 'Liaison vérifiée', description: `**Discord :** ${user || `<@${link.discord_user_id}>`}\n**Roblox :** **${profile?.username || link.roblox_username}**\n**Tag :** \`#${link.verification_rank}\`\n**Avertissements actifs :** \`${strikes[0]?.total || 0}\``, accentColor: EMBED_COLOR }));
    } catch (error) { databaseError(error); await interaction.editReply('Impossible d’effectuer cette recherche.'); }
  }

  app.post('/v1/roblox/permadeath-death', async (request, response) => {
    const received = tokenFrom(request);
    const expected = eventSecret();
    if (!tokensMatch(received, expected)) {
      console.warn('[Roblox] Webhook 401:', { header: request.get('authorization') ? 'present' : 'missing', received: fingerprint(received), expected: fingerprint(expected) });
      response.status(401).json({ error: 'Unauthorized.' });
      return;
    }
    if (!validDeathPayload(request.body)) { response.status(400).json({ error: 'Invalid permadeath death payload.' }); return; }
    if (!await initializeDatabase()) { response.status(503).json({ error: 'Database temporarily unavailable.' }); return; }
    const payload = request.body;
    try {
      const [insert] = await pool.execute('INSERT IGNORE INTO roblox_processed_death_events (event_id) VALUES (?)', [payload.eventId]);
      if (!insert.affectedRows) { response.json({ ok: true, duplicate: true }); return; }
      const [links] = await pool.execute('SELECT discord_user_id FROM roblox_discord_links WHERE roblox_user_id = ? LIMIT 1', [payload.robloxUserId]);
      if (!links[0]) { response.json({ ok: true, linked: false }); return; }
      try {
        const user = await client.users.fetch(links[0].discord_user_id);
        await user.send({ ...deathMessage(payload), allowedMentions: { parse: [] } });
        response.json({ ok: true, linked: true, delivered: true });
      } catch (error) { console.error('[Roblox] DM failed:', error.message); response.json({ ok: true, linked: true, delivered: false }); }
    } catch (error) { databaseError(error); response.status(503).json({ error: 'Database temporarily unavailable.' }); }
  });

  async function handleInteraction(interaction) {
    if (interaction.isChatInputCommand()) {
      if (![guildId, IDS.verificationGuild, IDS.commandGuild].includes(interaction.guildId)) return false;
      if (interaction.commandName === 'verification-panel') { await verificationPanel(interaction); return true; }
      if (interaction.commandName === 'panel-role') { await rolePanel(interaction); return true; }
      if (interaction.commandName === 'who-is') { await whoIs(interaction); return true; }
      if (interaction.commandName === 'unlink') { await unlink(interaction); return true; }
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('role_panel_')) return roleButton(interaction);
      if (interaction.customId === 'verify_panel_start') { await verificationStart(interaction); return true; }
      if (interaction.customId === 'verify_panel_check') { await verificationCheck(interaction); return true; }
    }
    if (interaction.isModalSubmit() && interaction.customId === 'verify_panel_username') { await verificationUsername(interaction); return true; }
    return false;
  }

  function startHttpServer() {
    if (server) return server;
    const port = portFromEnvironment();
    if (!eventSecret()) console.error('[Roblox] Missing ROBLOX_EVENT_SECRET on the bot host.');
    server = app.listen(port, '0.0.0.0', () => console.log(`[Roblox] HTTP server listening on 0.0.0.0:${port}.`));
    server.on('error', (error) => console.error('[Roblox] HTTP server error:', error.message));
    return server;
  }

  async function stopHttpServer() {
    if (!server) return;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    server = null;
  }

  return { initializeDatabase, startHttpServer, stopHttpServer, handleInteraction };
}
