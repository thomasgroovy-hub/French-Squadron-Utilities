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
import { randomInt } from 'node:crypto';
import { createV2EphemeralError, createV2Message } from './components.js';
import { createDatabasePool } from './database.js';
import { mirrorRobloxLink, reconcileRobloxMirror, unmirrorRobloxLink } from './roblox-mirror.js';
import {
  MODERATION_ROLE_ID,
  ROBLOX_LOOKUP_ROLE_ID,
  SUPER_ADMIN_ROLE_ID,
  hasGuildPermission,
} from './permissions.js';

const VERIFICATION_GUILD_ID = '1487258655840669807';
const VERIFICATION_PANEL_ROLE_ID = '1518410191933014057';
const UNLINK_ROLE_ID = '1487276505712033883';
const VERIFIED_ROLE_ID = '1534186084097851474';
const WHO_IS_CASEFILE_PREFIX = 'roblox_who_is_casefile:';
const CACHE_TTL = 5 * 60 * 1000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const robloxVerificationCommands = [
  new SlashCommandBuilder()
    .setName('verification-panel')
    .setDescription('Poste le panneau de vérification Roblox.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('who-is')
    .setDescription('Recherche une liaison Discord ou Roblox.')
    .setDefaultMemberPermissions(0)
    .addUserOption((option) => option
      .setName('discord')
      .setDescription('Membre Discord à rechercher'))
    .addStringOption((option) => option
      .setName('roblox')
      .setDescription('Pseudo Roblox à rechercher')
      .setMaxLength(20)),
  new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Détache le compte Roblox d’un utilisateur.')
    .setDefaultMemberPermissions(0)
    .addUserOption((option) => option
      .setName('utilisateur')
      .setDescription('Utilisateur à délier')
      .setRequired(true)),
];

const robloxCache = new Map();
const profileCache = new Map();

async function robloxJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Roblox est inaccessible.');
  }
  if (response.status === 404) throw new Error('Compte Roblox introuvable.');
  if (response.status === 429) throw new Error('Roblox limite temporairement les requêtes.');
  if (!response.ok) throw new Error(`Roblox a répondu HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error('Roblox a envoyé une réponse invalide.');
  }
}

async function findRobloxUser(username) {
  const normalizedUsername = username.trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(normalizedUsername)) {
    throw new Error('Le pseudo Roblox doit contenir entre 3 et 20 caractères valides.');
  }
  const key = normalizedUsername.toLowerCase();
  const cached = robloxCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const data = await robloxJson('https://users.roblox.com/v1/usernames/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usernames: [normalizedUsername], excludeBannedUsers: false }),
  });
  const user = data.data?.[0];
  if (!user?.id || !user.name) throw new Error('Ce pseudo Roblox est introuvable.');

  const value = { id: user.id, username: user.name };
  robloxCache.set(key, { value, expires: Date.now() + CACHE_TTL });
  return value;
}

async function getRobloxProfile(userId) {
  const cached = profileCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const user = await robloxJson(`https://users.roblox.com/v1/users/${userId}`);
  if (!user?.id || !user.name) throw new Error('Ce compte Roblox est introuvable.');

  const value = {
    id: user.id,
    username: user.name,
    description: user.description || '',
    createdAt: user.created ? new Date(user.created) : null,
  };
  profileCache.set(userId, { value, expires: Date.now() + CACHE_TTL });
  return value;
}

function makeCode() {
  return Array.from({ length: 6 }, () => (
    CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  )).join('');
}

// Returns one of: 'renamed' | 'has_nickname' | 'not_manageable' | 'skipped_bot'
async function syncNickname(member, robloxUsername, { overwrite = false } = {}) {
  if (member.user.bot) return 'skipped_bot';
  if (!overwrite && member.nickname) return 'has_nickname';
  if (!member.manageable) return 'not_manageable';
  await member.setNickname(robloxUsername.slice(0, 32), 'Synchronisation Roblox');
  return 'renamed';
}

export async function createRobloxVerificationIntegration({
  client,
  guildId,
  pool = createDatabasePool(),
}) {
  async function ensureTables() {
    if (!pool) return;
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS roblox_discord_links (
        discord_user_id VARCHAR(20) NOT NULL PRIMARY KEY,
        roblox_user_id BIGINT UNSIGNED NOT NULL,
        roblox_username VARCHAR(20) NOT NULL,
        verification_rank BIGINT UNSIGNED NOT NULL DEFAULT 0,
        verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY roblox_discord_links_roblox_user_id (roblox_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS roblox_pending_links (
        discord_user_id VARCHAR(20) NOT NULL PRIMARY KEY,
        roblox_user_id BIGINT UNSIGNED NOT NULL,
        roblox_username VARCHAR(20) NOT NULL,
        verification_code VARCHAR(6) NOT NULL,
        expires_at DATETIME NOT NULL,
        INDEX idx_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  await ensureTables();
  async function hasVerificationAccess(interaction) {
    return hasGuildPermission({
      client,
      guildId: VERIFICATION_GUILD_ID,
      userId: interaction.user.id,
      requiredPermission: PermissionFlagsBits.ManageGuild,
      allowedRoleIds: [VERIFICATION_PANEL_ROLE_ID, SUPER_ADMIN_ROLE_ID],
    });
  }

  async function hasWhoIsAccess(interaction) {
    return hasGuildPermission({
      client,
      guildId: VERIFICATION_GUILD_ID,
      userId: interaction.user.id,
      requiredPermission: PermissionFlagsBits.ModerateMembers,
      allowedRoleIds: [MODERATION_ROLE_ID, ROBLOX_LOOKUP_ROLE_ID, SUPER_ADMIN_ROLE_ID],
    });
  }

  async function fetchCaseFile(discordUserId) {
    const [[warnings], [cases], [bans]] = await Promise.all([
      pool.execute(
        `SELECT id, moderator_discord_id, raison, created_at
         FROM strikes WHERE discord_id = ? ORDER BY created_at DESC`,
        [discordUserId],
      ),
      pool.execute(
        `SELECT type, moderator_discord_id, raison, created_at
         FROM moderation_cases WHERE discord_id = ? ORDER BY created_at DESC`,
        [discordUserId],
      ),
      pool.execute(
        `SELECT guild_name, banned_at
         FROM moderation_bans WHERE discord_id = ? ORDER BY banned_at DESC`,
        [discordUserId],
      ),
    ]);
    return { warnings, cases, bans };
  }

  function formatCaseEntry(entry, kind) {
    const date = entry.created_at || entry.banned_at;
    const timestamp = Math.floor(new Date(date).getTime() / 1000);
    const reason = entry.raison || 'Non renseignée';
    if (kind === 'warn') {
      return `**Avertissement n°${entry.id} | <t:${timestamp}:d>**\nRaison : ${reason}\nModérateur : <@${entry.moderator_discord_id}>`;
    }
    if (kind === 'ban') {
      return `**Ban actuel | <t:${timestamp}:d>**\nServeur : ${entry.guild_name}\nStatut : actif`;
    }
    const labels = {
      bannissement: 'Ban historique',
      exclusion: 'Timeout',
      expulsion: 'Expulsion',
    };
    return `**${labels[entry.type] || entry.type} | <t:${timestamp}:d>**\nRaison : ${reason}\nModérateur : <@${entry.moderator_discord_id}>\nStatut : historique`;
  }

  async function caseFile(interaction, discordUserId) {
    if (!await hasWhoIsAccess(interaction)) {
      await interaction.reply(createV2EphemeralError('Tu n’as pas le rôle nécessaire pour consulter ce casier.'));
      return;
    }
    if (!pool) {
      await interaction.reply(createV2EphemeralError('La base de données est temporairement indisponible.'));
      return;
    }
    try {
      const { warnings, cases, bans } = await fetchCaseFile(discordUserId);
      const sections = [];
      if (warnings.length) {
        sections.push(`### Avertissements\n${warnings.map((item) => formatCaseEntry(item, 'warn')).join('\n\n')}`);
      }
      const timeoutCases = cases.filter((item) => item.type === 'exclusion');
      if (timeoutCases.length) {
        sections.push(`### Timeouts\n${timeoutCases.map((item) => formatCaseEntry(item, 'case')).join('\n\n')}`);
      }
      const historicalBans = cases.filter((item) => item.type === 'bannissement');
      if (historicalBans.length || bans.length) {
        sections.push(`### Bans\n${[
          ...bans.map((item) => formatCaseEntry(item, 'ban')),
          ...historicalBans.map((item) => formatCaseEntry(item, 'case')),
        ].join('\n\n')}`);
      }
      const otherCases = cases.filter((item) => !['exclusion', 'bannissement'].includes(item.type));
      if (otherCases.length) {
        sections.push(`### Autres sanctions\n${otherCases.map((item) => formatCaseEntry(item, 'case')).join('\n\n')}`);
      }
      await interaction.reply(createV2Message({
        title: 'Casier de modération',
        description: sections.length ? `Utilisateur : <@${discordUserId}>` : 'Aucune sanction enregistrée.',
        sections: sections.length ? sections : [],
        ephemeral: true,
      }));
    } catch (error) {
      console.error('[RobloxVerification] Unable to load case file:', error.message);
      await interaction.reply(createV2EphemeralError('Impossible de récupérer le casier de modération.'));
    }
  }

  async function updateVerifiedRole(userId, remove = false) {
    try {
      const guild = client.guilds.cache.get(VERIFICATION_GUILD_ID);
      const [member, role, botMember] = await Promise.all([
        guild?.members.fetch(userId).catch(() => null),
        guild?.roles.fetch(VERIFIED_ROLE_ID).catch(() => null),
        guild?.members.fetch(client.user.id).catch(() => null),
      ]);
      if (!member || !role || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
      if (role.position >= botMember.roles.highest.position) return false;
      if (remove) await member.roles.remove(role);
      else await member.roles.add(role);
      return true;
    } catch (error) {
      console.error('[RobloxVerification] Role update failed:', error.message);
      return false;
    }
  }

  async function verificationPanel(interaction) {
    if (!await hasVerificationAccess(interaction)) {
      await interaction.reply(createV2EphemeralError('Tu n’as pas le rôle nécessaire pour poster le panneau.'));
      return;
    }
    await interaction.reply(createV2Message({
      title: 'Vérifie ton Roblox',
      description: 'Inscris ton pseudo Roblox puis place le code fourni dans ta bio Roblox.',
      actionRow: new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('verify_panel_start')
          .setLabel('Se vérifier')
          .setStyle(ButtonStyle.Primary),
      ),
    }));
  }

  async function verificationStart(interaction) {
    if (!pool) {
      await interaction.reply(createV2EphemeralError('La base de données est temporairement indisponible.'));
      return;
    }
    try {
      const [rows] = await pool.execute(
        'SELECT roblox_username FROM roblox_discord_links WHERE discord_user_id = ? LIMIT 1',
        [interaction.user.id],
      );
      if (rows[0]) {
        await interaction.reply(createV2EphemeralError(`Tu es déjà vérifié avec **${rows[0].roblox_username}**.`, 'Déjà vérifié'));
        return;
      }
      const modal = new ModalBuilder()
        .setCustomId('verify_panel_username')
        .setTitle('Vérifie ton Roblox');
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('roblox_username')
          .setLabel('Pseudo Roblox')
          .setPlaceholder('Ton nom d’utilisateur Roblox')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(3)
          .setMaxLength(20),
      ));
      await interaction.showModal(modal);
    } catch (error) {
      console.error('[RobloxVerification] Unable to start verification:', error.message);
      await interaction.reply(createV2EphemeralError('Impossible de démarrer la vérification.')).catch(() => {});
    }
  }

  async function verificationUsername(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!pool) {
      await interaction.editReply('La base de données est temporairement indisponible.');
      return;
    }
    try {
      const user = await findRobloxUser(interaction.fields.getTextInputValue('roblox_username'));
      const code = makeCode();
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [linked] = await connection.execute(
          'SELECT discord_user_id FROM roblox_discord_links WHERE roblox_user_id = ? LIMIT 1 FOR UPDATE',
          [user.id],
        );
        if (linked[0] && linked[0].discord_user_id !== interaction.user.id) {
          await connection.rollback();
          await interaction.editReply('Ce compte Roblox est déjà lié à un autre compte Discord.');
          return;
        }
        const [pending] = await connection.execute(
          'SELECT discord_user_id FROM roblox_pending_links WHERE roblox_user_id = ? AND expires_at > UTC_TIMESTAMP() LIMIT 1 FOR UPDATE',
          [user.id],
        );
        if (pending[0] && pending[0].discord_user_id !== interaction.user.id) {
          await connection.rollback();
          await interaction.editReply('Une vérification est déjà en cours pour ce compte Roblox.');
          return;
        }
        await connection.execute('DELETE FROM roblox_pending_links WHERE discord_user_id = ?', [interaction.user.id]);
        await connection.execute(
          'INSERT INTO roblox_pending_links (discord_user_id, roblox_user_id, roblox_username, verification_code, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE))',
          [interaction.user.id, user.id, user.username, code],
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
      await interaction.editReply(createV2Message({
        title: 'Code de vérification Roblox',
        description: `Place ce code dans ta bio Roblox :\n\n\`\`\`\n${code}\n\`\`\``,
        sections: ['Tu as 15 minutes, puis clique sur **Vérifier mon code**.'],
        actionRow: new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('verify_panel_check')
            .setLabel('Vérifier mon code')
            .setStyle(ButtonStyle.Success),
        ),
      }));
    } catch (error) {
      console.error('[RobloxVerification] Unable to create verification:', error.message);
      await interaction.editReply('Impossible de créer la demande de vérification.');
    }
  }

  async function verificationCheck(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!pool) {
      await interaction.editReply('La base de données est temporairement indisponible.');
      return;
    }
    try {
      const [rows] = await pool.execute(
        'SELECT roblox_user_id, verification_code, expires_at, expires_at <= UTC_TIMESTAMP() AS expired FROM roblox_pending_links WHERE discord_user_id = ? LIMIT 1',
        [interaction.user.id],
      );
      const pending = rows[0];
      if (!pending) {
        await interaction.editReply('Aucune demande active.');
        return;
      }
      if (Number(pending.expired) === 1 || pending.expired === true) {
        await pool.execute('DELETE FROM roblox_pending_links WHERE discord_user_id = ?', [interaction.user.id]);
        await interaction.editReply('Le code a expiré.');
        return;
      }
      const profile = await getRobloxProfile(pending.roblox_user_id);
      if (!profile.description.includes(pending.verification_code)) {
        await interaction.editReply('Le code n’est pas présent dans ta bio Roblox.');
        return;
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [conflict] = await connection.execute(
          'SELECT discord_user_id FROM roblox_discord_links WHERE roblox_user_id = ? FOR UPDATE',
          [pending.roblox_user_id],
        );
        if (conflict[0] && conflict[0].discord_user_id !== interaction.user.id) {
          await connection.rollback();
          await interaction.editReply('Ce compte est déjà lié.');
          return;
        }
        await connection.execute('DELETE FROM roblox_discord_links WHERE discord_user_id = ?', [interaction.user.id]);
        await connection.execute(
          'INSERT INTO roblox_discord_links (discord_user_id, roblox_user_id, roblox_username, verification_rank, verified_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP())',
          [interaction.user.id, pending.roblox_user_id, profile.username, Math.floor(Date.now() / 1000)],
        );
        await connection.execute('DELETE FROM roblox_pending_links WHERE discord_user_id = ?', [interaction.user.id]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }

      // The site reads its own copy, so the link has to be mirrored once the
      // bot's own transaction is committed.
      await mirrorRobloxLink(interaction.user.id, { pool });

      let nicknameFailed = false;
      if (interaction.member) {
        try {
          const nicknameResult = await syncNickname(
            interaction.member,
            profile.username,
            { overwrite: true },
          );
          nicknameFailed = nicknameResult === 'not_manageable';
        } catch (error) {
          console.error('[RobloxVerification] Unable to update nickname:', error.message);
          nicknameFailed = true;
        }
      }

      const assigned = await updateVerifiedRole(interaction.user.id);
      const sections = [
        assigned ? 'Le rôle vérifié a été attribué.' : 'La liaison est enregistrée, mais le rôle n’a pas pu être attribué.',
      ];
      if (nicknameFailed) {
        sections.push('Ton compte est lié, mais je n’ai pas pu modifier ton surnom (permissions du bot).');
      }
      await interaction.editReply(createV2Message({
        title: 'Vérification réussie',
        description: `**${profile.username}** est associé à ton compte Discord.`,
        sections,
      }));
    } catch (error) {
      console.error('[RobloxVerification] Unable to verify account:', error.message);
      await interaction.editReply('Impossible de vérifier la liaison.');
    }
  }

  async function whoIs(interaction) {
    if (!await hasWhoIsAccess(interaction)) {
      await interaction.reply(createV2EphemeralError('Tu n’as pas le rôle nécessaire pour utiliser cette commande.'));
      return;
    }
    const discordUser = interaction.options.getUser('discord');
    const robloxName = interaction.options.getString('roblox')?.trim();
    if (!discordUser && !robloxName) {
      await interaction.reply(createV2EphemeralError('Renseigne `discord` ou `roblox`.'));
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    if (!pool) {
      await interaction.editReply('La base de données est temporairement indisponible.');
      return;
    }
    try {
      const [rows] = await pool.execute(
        discordUser
          ? 'SELECT discord_user_id, roblox_user_id, roblox_username, verified_at FROM roblox_discord_links WHERE discord_user_id = ? LIMIT 1'
          : 'SELECT discord_user_id, roblox_user_id, roblox_username, verified_at FROM roblox_discord_links WHERE LOWER(roblox_username) = LOWER(?) LIMIT 1',
        [discordUser?.id || robloxName],
      );
      const link = rows[0];
      if (!link) {
        await interaction.editReply(discordUser ? 'Cette personne n’est pas vérifiée.' : 'Aucune liaison ne correspond à ce pseudo.');
        return;
      }
      const user = discordUser || await client.users.fetch(link.discord_user_id).catch(() => null);
      const profile = await getRobloxProfile(link.roblox_user_id).catch((error) => {
        console.error('[RobloxVerification] Unable to load Roblox profile:', error.message);
        return null;
      });
      const discordCreatedAt = user?.createdAt || (user?.createdTimestamp ? new Date(user.createdTimestamp) : null);
      const discordSection = user
        ? `### Discord\n${user}\nMention : <@${user.id}>\nID : ${user.id}\nCompte créé : ${formatDate(discordCreatedAt)}\nÂge : ${formatAccountAge(discordCreatedAt)}`
        : `### Discord\nUtilisateur introuvable\nID : ${link.discord_user_id}`;
      const robloxSection = profile
        ? `### Roblox\nUsername : **${profile.username}**\nID : ${profile.id}\nCompte créé : ${formatDate(profile.createdAt)}\nÂge : ${formatAccountAge(profile.createdAt)}`
        : `### Roblox\nUsername : **${link.roblox_username}**\nID : ${link.roblox_user_id}\nInformations Roblox indisponibles.`;
      await interaction.editReply(createV2Message({
        title: 'Fiche Roblox / Discord',
        description: `${discordSection}\n\n${robloxSection}`,
        actionRow: new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${WHO_IS_CASEFILE_PREFIX}${link.discord_user_id}`)
            .setLabel('Voir le casier de modération')
            .setStyle(ButtonStyle.Secondary),
        ),
      }));
    } catch (error) {
      console.error('[RobloxVerification] Unable to find link:', error.message);
      await interaction.editReply('Impossible d’effectuer cette recherche.');
    }
  }

  async function unlink(interaction) {
    const allowed = await hasGuildPermission({
      client,
      guildId: VERIFICATION_GUILD_ID,
      userId: interaction.user.id,
      requiredPermission: PermissionFlagsBits.ModerateMembers,
      allowedRoleIds: [UNLINK_ROLE_ID, MODERATION_ROLE_ID, ROBLOX_LOOKUP_ROLE_ID, SUPER_ADMIN_ROLE_ID],
    });
    if (!allowed) {
      await interaction.reply(createV2EphemeralError('Tu n’as pas le rôle nécessaire pour utiliser cette commande.'));
      return;
    }

    const target = interaction.options.getUser('utilisateur', true);
    await interaction.deferReply({ ephemeral: true });
    if (!pool) {
      await interaction.editReply('La base de données est temporairement indisponible.');
      return;
    }

    try {
      const [rows] = await pool.execute(
        'SELECT roblox_username FROM roblox_discord_links WHERE discord_user_id = ? LIMIT 1',
        [target.id],
      );
      if (!rows[0]) {
        await interaction.editReply(`Aucun compte Roblox n’est lié à ${target}.`);
        return;
      }
      await pool.execute(
        'DELETE FROM roblox_discord_links WHERE discord_user_id = ?',
        [target.id],
      );
      await unmirrorRobloxLink(target.id);
      await updateVerifiedRole(target.id, true);
      await interaction.editReply(`La liaison de ${target} avec **${rows[0].roblox_username}** a été supprimée.`);
    } catch (error) {
      console.error('[RobloxVerification] Unable to unlink account:', error.message);
      await interaction.editReply('Impossible de supprimer la liaison.');
    }
  }

  async function handleInteraction(interaction) {
    if (interaction.isButton() && interaction.customId.startsWith(WHO_IS_CASEFILE_PREFIX)) {
      const discordUserId = interaction.customId.slice(WHO_IS_CASEFILE_PREFIX.length);
      if (!/^\d{17,20}$/.test(discordUserId)) {
        await interaction.reply(createV2EphemeralError('Identifiant utilisateur invalide.'));
        return true;
      }
      await caseFile(interaction, discordUserId);
      return true;
    }
    if (interaction.isChatInputCommand()) {
      if (![guildId, VERIFICATION_GUILD_ID].includes(interaction.guildId)) return false;
      if (interaction.commandName === 'verification-panel') {
        await verificationPanel(interaction);
        return true;
      }
      if (interaction.commandName === 'who-is') {
        await whoIs(interaction);
        return true;
      }
      if (interaction.commandName === 'unlink') {
        await unlink(interaction);
        return true;
      }
    }
    if (interaction.isButton()) {
      if (interaction.customId === 'verify_panel_start') {
        await verificationStart(interaction);
        return true;
      }
      if (interaction.customId === 'verify_panel_check') {
        await verificationCheck(interaction);
        return true;
      }
    }
    if (interaction.isModalSubmit() && interaction.customId === 'verify_panel_username') {
      await verificationUsername(interaction);
      return true;
    }
    return false;
  }

  return {
    handleInteraction,
    /**
     * Re-aligns the site's mirror with the bot's table. Called on startup so a
     * failed write or a manual edit is repaired, and so links that predate the
     * mirror get backfilled.
     */
    syncSiteMirror: () => reconcileRobloxMirror({ pool }),
  };
}

function formatAccountAge(createdAt, now = new Date()) {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) return 'Inconnu';
  let years = now.getUTCFullYear() - createdAt.getUTCFullYear();
  let months = now.getUTCMonth() - createdAt.getUTCMonth();
  if (now.getUTCDate() < createdAt.getUTCDate()) months -= 1;
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return `${years} an${years > 1 ? 's' : ''}, ${months} mois`;
}

function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'Inconnue';
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}