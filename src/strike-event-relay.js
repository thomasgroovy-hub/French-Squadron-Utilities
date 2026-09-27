import { EmbedBuilder } from 'discord.js';
import { createDatabasePool } from './database.js';

export const STRIKE_EVENTS_TABLE = 'strike_events';
export const STRIKE_LOG_CHANNEL_ID =
  process.env.STRIKE_LOG_CHANNEL_ID || '1546193398388494336';

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 25;
const MAX_REASON_LENGTH = 1000;

const ACTION_PRESENTATION = Object.freeze({
  created: { label: 'Avertissement ajouté', color: 0xfbbf24 },
  updated: { label: 'Avertissement modifié', color: 0x7fd1c1 },
  deleted: { label: 'Avertissement supprimé', color: 0xf87171 },
});

function log(level, message, details = undefined) {
  console[level](
    `[StrikeLog] ${message}`,
    ...(details === undefined ? [] : [details]),
  );
}

const tableState = new WeakMap();

/**
 * Mirrors the site's DDL. Both sides use `CREATE TABLE IF NOT EXISTS`, so the
 * first process to boot fixes the shape and the other statement is a no-op.
 * The audit trail is the bot's only source of truth for removals, so it creates
 * the table itself rather than waiting for somebody to touch the site.
 */
export async function ensureStrikeEventsTable(pool) {
  if (!pool || typeof pool.query !== 'function') return false;

  let state = tableState.get(pool);
  if (!state) {
    state = { ready: false, initialization: null };
    tableState.set(pool, state);
  }
  if (state.ready) return true;
  if (state.initialization) return state.initialization;

  state.initialization = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${STRIKE_EVENTS_TABLE} (
          id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
          strike_id BIGINT UNSIGNED NULL,
          action ENUM('created', 'updated', 'deleted') NOT NULL,
          target_discord_id VARCHAR(20) NOT NULL,
          target_name VARCHAR(80) NULL,
          actor_discord_id VARCHAR(20) NOT NULL,
          actor_name VARCHAR(80) NULL,
          previous_reason VARCHAR(${MAX_REASON_LENGTH}) NULL,
          new_reason VARCHAR(${MAX_REASON_LENGTH}) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          relayed_at DATETIME NULL,
          INDEX strike_events_pending_idx (relayed_at, id),
          INDEX strike_events_target_idx (target_discord_id),
          INDEX strike_events_actor_idx (actor_discord_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      state.ready = true;
      return true;
    } catch (error) {
      log('error', `Création de ${STRIKE_EVENTS_TABLE} impossible:`, error.message);
      return false;
    } finally {
      state.initialization = null;
    }
  })();

  return state.initialization;
}

function describeUser(id, name) {
  const label = name ? `${name} (\`${id}\`)` : `\`${id}\``;
  return label;
}

export function createStrikeEventEmbed(event, timestamp = new Date()) {
  const presentation = ACTION_PRESENTATION[event.action] ?? {
    label: `Avertissement ${event.action}`,
    color: 0x9aa3b2,
  };

  const embed = new EmbedBuilder()
    .setTitle(presentation.label)
    .setColor(presentation.color)
    .setTimestamp(timestamp)
    .addFields({
      name: 'Membre',
      value: describeUser(event.target_discord_id, event.target_name),
      inline: true,
    })
    .addFields({
      name: 'Effectué par',
      value: describeUser(event.actor_discord_id, event.actor_name),
      inline: true,
    });

  if (event.strike_id) {
    embed.addFields({ name: 'Avertissement', value: `#${event.strike_id}`, inline: true });
  }

  if (event.action === 'updated') {
    embed.addFields(
      { name: 'Ancienne raison', value: event.previous_reason || '*Non renseignée*' },
      { name: 'Nouvelle raison', value: event.new_reason || '*Non renseignée*' },
    );
  } else if (event.action === 'created') {
    embed.addFields({ name: 'Raison', value: event.new_reason || '*Non renseignée*' });
  } else {
    embed.addFields({ name: 'Raison supprimée', value: event.previous_reason || '*Non renseignée*' });
  }

  embed.setFooter({ text: 'Audit des sanctions — Site-66' });
  return embed;
}

export function createStrikeEventRelay({
  client,
  pool = createDatabasePool(),
  channelId = STRIKE_LOG_CHANNEL_ID,
  intervalMs = DEFAULT_INTERVAL_MS,
  batchSize = DEFAULT_BATCH_SIZE,
} = {}) {
  // A slow or failing send must not overlap with the next tick, otherwise a
  // backlog would be relayed twice and duplicate the audit lines in Discord.
  let inFlight = false;
  let timer = null;

  async function fetchPendingEvents() {
    const [rows] = await pool.execute(
      `SELECT id, strike_id, action, target_discord_id, target_name,
              actor_discord_id, actor_name, previous_reason, new_reason, created_at
         FROM ${STRIKE_EVENTS_TABLE}
        WHERE relayed_at IS NULL
        ORDER BY id ASC
        LIMIT ?`,
      [batchSize],
    );
    return rows;
  }

  async function markRelayed(id) {
    await pool.execute(
      `UPDATE ${STRIKE_EVENTS_TABLE} SET relayed_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [id],
    );
  }

  async function sendEvent(event) {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased?.()) {
      throw new Error(`Le salon ${channelId} est introuvable ou n'accepte pas de message.`);
    }
    await channel.send({
      embeds: [createStrikeEventEmbed(event, new Date(event.created_at ?? Date.now()))],
      // Audit line: nobody gets pinged, not even the member it concerns.
      allowedMentions: { parse: [] },
    });
  }

  async function relayPendingEvents() {
    if (!pool) {
      log('error', 'La connexion BDD est indisponible, relais des sanctions impossible.');
      return 0;
    }
    if (!(await ensureStrikeEventsTable(pool))) return 0;

    let events;
    try {
      events = await fetchPendingEvents();
    } catch (error) {
      log('error', 'Lecture des audits de sanctions impossible:', error.message);
      return 0;
    }
    if (!events.length) return 0;

    let relayed = 0;
    for (const event of events) {
      try {
        await sendEvent(event);
      } catch (error) {
        // Left un-relayed on purpose: a missing permission or a Discord outage
        // must not silently drop the line. It goes out on a later tick.
        log('error', `Relais de l'audit #${event.id} impossible:`, error.message);
        break;
      }
      try {
        await markRelayed(event.id);
        relayed += 1;
      } catch (error) {
        log('error', `Audit #${event.id} envoyé mais marqué comme échoué:`, error.message);
        break;
      }
    }

    if (relayed) log('info', `${relayed} audit(s) de sanction relayé(s).`);
    return relayed;
  }

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      await relayPendingEvents();
    } catch (error) {
      log('error', 'Relais des sanctions : erreur inattendue :', error.message);
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (timer) return;
    void tick();
    timer = setInterval(() => void tick(), intervalMs);
    // The relay must never be the reason the process stays alive.
    if (typeof timer.unref === 'function') timer.unref();
    log('info', `Relais des sanctions actif vers le salon ${channelId}.`);
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, relayPendingEvents, ensureStrikeEventsTable };
}
