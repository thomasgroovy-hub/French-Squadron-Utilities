import express from 'express';
import mysql from 'mysql2/promise';
import { randomInt, timingSafeEqual } from 'node:crypto';
import { SlashCommandBuilder } from 'discord.js';
import { Tunnel } from 'cloudflared';

const ROBLOX_USERNAME_LOOKUP_URL = 'https://users.roblox.com/v1/usernames/users';
const ROBLOX_USER_URL = 'https://users.roblox.com/v1/users/';
const VERIFICATION_CODE_LENGTH = 6;
const VERIFICATION_EXPIRY_MINUTES = 15;
const DATABASE_RETRY_DELAY_MS = 60_000;
const QUICK_TUNNEL_START_TIMEOUT_MS = 30_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const robloxCommands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Lie ton compte Roblox à ton compte Discord.')
    .addStringOption((option) => option
      .setName('roblox-username')
      .setDescription('Ton nom d’utilisateur Roblox exact')
      .setRequired(true)
      .setMinLength(3)
      .setMaxLength(20)),
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Vérifie le code placé dans ta bio Roblox.'),
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

async function findRobloxUser(username) {
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

  return { id: user.id, username: user.name };
}

async function getRobloxProfile(robloxUserId) {
  const user = await fetchRobloxJson(`${ROBLOX_USER_URL}${robloxUserId}`);
  if (!user?.id || !user?.name) {
    throw new RobloxApiError('notFound', 'This Roblox account no longer exists.');
  }

  return {
    username: user.name,
    description: user.description || '',
  };
}

function robloxErrorMessage(error) {
  if (error instanceof RobloxApiError) {
    if (error.kind === 'notFound') return 'Compte Roblox introuvable. Vérifie le nom d’utilisateur et réessaie.';
    if (error.kind === 'rateLimit') return 'Roblox limite temporairement les vérifications. Réessaie dans quelques minutes.';
    return 'Impossible de joindre Roblox pour le moment. Réessaie bientôt.';
  }
  return 'Une erreur inattendue est survenue pendant la vérification Roblox.';
}

function deathDmMessage(payload) {
  const occurredAt = Number.isSafeInteger(payload.occurredAt)
    ? `<t:${payload.occurredAt}:F>`
    : 'à un moment inconnu';

  return `Ton personnage Roblox **${payload.robloxUsername}** est mort pendant une session de permadeath (${occurredAt}).`;
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

  async function handleLink(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!(await requireDatabase(interaction))) return;

    const requestedUsername = interaction.options.getString('roblox-username', true).trim();
    try {
      const robloxUser = await findRobloxUser(requestedUsername);
      const [existingLinks] = await pool.execute(
        'SELECT discord_user_id FROM roblox_discord_links WHERE roblox_user_id = ? LIMIT 1',
        [robloxUser.id],
      );

      if (existingLinks[0] && existingLinks[0].discord_user_id !== interaction.user.id) {
        await interaction.editReply('Ce compte Roblox est déjà lié à un autre compte Discord.');
        return;
      }

      if (existingLinks[0]?.discord_user_id === interaction.user.id) {
        await interaction.editReply(`**${robloxUser.username}** est déjà lié à ton compte Discord.`);
        return;
      }

      await pool.execute(
        'DELETE FROM roblox_pending_links WHERE roblox_user_id = ? AND expires_at <= UTC_TIMESTAMP()',
        [robloxUser.id],
      );
      const [existingPendingLinks] = await pool.execute(
        'SELECT discord_user_id FROM roblox_pending_links WHERE roblox_user_id = ? LIMIT 1',
        [robloxUser.id],
      );
      if (existingPendingLinks[0] && existingPendingLinks[0].discord_user_id !== interaction.user.id) {
        await interaction.editReply('Une vérification est déjà en cours pour ce compte Roblox. Réessaie plus tard.');
        return;
      }

      const verificationCode = await createPendingLink(interaction.user.id, robloxUser);
      await interaction.editReply(
        `Place ce code dans la section **About / Bio** de ton profil Roblox : \`${verificationCode}\`\n\nEnsuite, utilise \`/verify\` dans les 15 minutes. Ne partage pas ce code; tu pourras le retirer de ta bio après la vérification.`,
      );
    } catch (error) {
      if (error instanceof RobloxApiError) {
        await interaction.editReply(robloxErrorMessage(error));
        return;
      }
      markDatabaseUnavailable(error);
      await interaction.editReply('Impossible de créer la demande de liaison. Réessaie plus tard.');
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
      await connection.execute(
        `INSERT INTO roblox_discord_links (discord_user_id, roblox_user_id, roblox_username)
         VALUES (?, ?, ?)`,
        [discordUserId, pendingLink.roblox_user_id, robloxUsername],
      );
      await connection.execute('DELETE FROM roblox_pending_links WHERE discord_user_id = ?', [discordUserId]);
      await connection.commit();
      return true;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async function handleVerify(interaction) {
    await interaction.deferReply({ ephemeral: true });
    if (!(await requireDatabase(interaction))) return;

    try {
      const [pendingLinks] = await pool.execute(
        `SELECT
           roblox_user_id,
           roblox_username,
           verification_code,
           DATE_FORMAT(expires_at, '%Y-%m-%d %H:%i:%s') AS expires_at_utc,
           DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%d %H:%i:%s') AS checked_at_utc,
           TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), expires_at) AS seconds_remaining
         FROM roblox_pending_links
         WHERE discord_user_id = ?
         LIMIT 1`,
        [interaction.user.id],
      );
      const pendingLink = pendingLinks[0];

      if (!pendingLink) {
        await interaction.editReply('Aucune demande de liaison active. Utilise d’abord `/link <roblox username>`.');
        return;
      }

      console.log(
        `[Roblox] Verification expiry check for Discord user ${interaction.user.id}: `
        + `expires_at_utc=${pendingLink.expires_at_utc}, checked_at_utc=${pendingLink.checked_at_utc}, `
        + `seconds_remaining=${pendingLink.seconds_remaining}.`,
      );

      if (Number(pendingLink.seconds_remaining) <= 0) {
        await pool.execute('DELETE FROM roblox_pending_links WHERE discord_user_id = ?', [interaction.user.id]);
        await interaction.editReply('Ton code a expiré. Utilise `/link <roblox username>` pour en générer un nouveau.');
        return;
      }

      const profile = await getRobloxProfile(pendingLink.roblox_user_id);
      if (!profile.description.includes(pendingLink.verification_code)) {
        await interaction.editReply(
          `Je ne trouve pas le code \`${pendingLink.verification_code}\` dans ta bio Roblox. Vérifie qu’il est bien enregistré, puis réessaie avant son expiration.`,
        );
        return;
      }

      const saved = await saveVerifiedLink(interaction.user.id, pendingLink, profile.username);
      if (!saved) {
        await interaction.editReply('Ce compte Roblox vient d’être lié à un autre compte Discord.');
        return;
      }

      await interaction.editReply(
        `Liaison réussie : **${profile.username}** est maintenant associé à ton compte Discord. Tu peux retirer le code de ta bio Roblox.`,
      );
    } catch (error) {
      if (error instanceof RobloxApiError) {
        await interaction.editReply(robloxErrorMessage(error));
        return;
      }
      markDatabaseUnavailable(error);
      await interaction.editReply('Impossible de vérifier la liaison pour le moment. Réessaie plus tard.');
    }
  }

  async function handleRobloxInteraction(interaction) {
    if (!interaction.isChatInputCommand() || interaction.guildId !== guildId) return false;

    if (interaction.commandName === 'link') {
      await handleLink(interaction);
      return true;
    }
    if (interaction.commandName === 'verify') {
      await handleVerify(interaction);
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
          content: deathDmMessage(payload),
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
          return;
        }
        console.error(`[Roblox] Cloudflare Quick Tunnel stopped (code=${code}, signal=${signal ?? 'none'}). The webhook is no longer public.`);
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
