import mysql from 'mysql2/promise';

/**
 * The companion site runs on a different MySQL server and cannot reach the
 * bot's database, so Roblox links are mirrored into a `roblox_links` table the
 * site owns. The bot stays the single writer and the site only ever reads, so a
 * bot outage leaves the site showing the last known state instead of breaking.
 *
 * Every write here is best effort: a mirror failure must never break the bot's
 * own verification flow, which remains authoritative in `roblox_discord_links`.
 */

const MIRROR_COLUMNS = 'discord_user_id, verification_rank, roblox_user_id, roblox_username, verified_at';

let mirrorPool = null;
let mirrorUnavailableLogged = false;

/**
 * The site is only mirrored when its own credentials are configured, so a
 * local run without them keeps working exactly as before.
 */
export function isRobloxMirrorConfigured() {
  return Boolean(
    process.env.SITE_MYSQL_HOST
    && process.env.SITE_MYSQL_USER
    && process.env.SITE_MYSQL_PASSWORD
    && process.env.SITE_MYSQL_DATABASE,
  );
}

export function getRobloxMirrorPool() {
  if (!isRobloxMirrorConfigured()) return null;
  if (mirrorPool) return mirrorPool;
  mirrorPool = mysql.createPool({
    host: process.env.SITE_MYSQL_HOST,
    port: Number.parseInt(process.env.SITE_MYSQL_PORT || '3306', 10),
    user: process.env.SITE_MYSQL_USER,
    password: process.env.SITE_MYSQL_PASSWORD,
    database: process.env.SITE_MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 2,
    connectTimeout: 10_000,
  });
  return mirrorPool;
}

async function ensureMirrorTable(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS roblox_links (
      discord_user_id VARCHAR(20) NOT NULL PRIMARY KEY,
      verification_rank BIGINT UNSIGNED NOT NULL,
      roblox_user_id BIGINT UNSIGNED NOT NULL,
      roblox_username VARCHAR(20) NOT NULL,
      verified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY roblox_links_roblox_user_id (roblox_user_id),
      UNIQUE KEY roblox_links_verification_rank (verification_rank)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function logMirrorFailure(message, error) {
  if (/Unknown database|ER_DBACCESS_DENIED/.test(error.message)) {
    if (mirrorUnavailableLogged) return;
    mirrorUnavailableLogged = true;
    console.warn(`[RobloxMirror] ${message} (further messages for this cause are suppressed)`);
    return;
  }
  console.error(`[RobloxMirror] ${message}: ${error.message}`);
}

/** Closes the mirror pool, so the bot can shut down without a dangling handle. */
export async function closeRobloxMirrorPool() {
  if (!mirrorPool) return;
  const pool = mirrorPool;
  mirrorPool = null;
  await pool.end();
}

/**
 * Copies one link from the bot's table into the site. Returns false instead of
 * throwing so callers can treat mirroring as optional.
 */
export async function mirrorRobloxLink(discordUserId, { pool, sitePool = getRobloxMirrorPool() } = {}) {
  if (!sitePool || !discordUserId) return false;
  try {
    const [rows] = await pool.execute(
      `SELECT ${MIRROR_COLUMNS} FROM roblox_discord_links WHERE discord_user_id = ? LIMIT 1`,
      [discordUserId],
    );
    if (!rows.length) return unmirrorRobloxLink(discordUserId, { sitePool });

    await ensureMirrorTable(sitePool);
    const link = rows[0];
    await sitePool.execute(
      `INSERT INTO roblox_links (${MIRROR_COLUMNS})
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         roblox_user_id = VALUES(roblox_user_id),
         roblox_username = VALUES(roblox_username),
         verified_at = VALUES(verified_at)`,
      [link.discord_user_id, link.verification_rank, link.roblox_user_id, link.roblox_username, link.verified_at],
    );
    return true;
  } catch (error) {
    logMirrorFailure(`unable to mirror the link of ${discordUserId}`, error);
    return false;
  }
}

/** Drops a link from the site when the bot drops it, so it cannot go stale. */
export async function unmirrorRobloxLink(discordUserId, { sitePool = getRobloxMirrorPool() } = {}) {
  if (!sitePool || !discordUserId) return false;
  try {
    await ensureMirrorTable(sitePool);
    await sitePool.execute('DELETE FROM roblox_links WHERE discord_user_id = ?', [discordUserId]);
    return true;
  } catch (error) {
    logMirrorFailure(`unable to remove the mirrored link of ${discordUserId}`, error);
    return false;
  }
}

/**
 * Brings the whole mirror back in line with the bot's table: upserts every
 * link and deletes the ones the bot no longer has. This runs on startup, so it
 * repairs anything a failed write or a manual edit left behind, and it is also
 * the backfill for links that predate the mirror.
 */
export async function reconcileRobloxMirror({ pool, sitePool = getRobloxMirrorPool() } = {}) {
  if (!sitePool) return { synced: 0, removed: 0, skipped: true };
  try {
    await ensureMirrorTable(sitePool);
    const [rows] = await pool.execute(`SELECT ${MIRROR_COLUMNS} FROM roblox_discord_links`);

    const sourceIds = rows.map((link) => link.discord_user_id);
    let synced = 0;
    for (const link of rows) {
      await sitePool.execute(
        `INSERT INTO roblox_links (${MIRROR_COLUMNS})
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           roblox_user_id = VALUES(roblox_user_id),
           roblox_username = VALUES(roblox_username),
           verified_at = VALUES(verified_at)`,
        [link.discord_user_id, link.verification_rank, link.roblox_user_id, link.roblox_username, link.verified_at],
      );
      synced += 1;
    }

    // `NOT IN ()` is invalid SQL, so an empty source means "remove everything".
    const [stale] = sourceIds.length
      ? await sitePool.execute(
        `DELETE FROM roblox_links WHERE discord_user_id NOT IN (${sourceIds.map(() => '?').join(', ')})`,
        sourceIds,
      )
      : await sitePool.execute('DELETE FROM roblox_links');
    const removed = stale?.affectedRows || 0;

    console.log(`[RobloxMirror] Reconciled: ${synced} link(s) mirrored, ${removed} removed.`);
    return { synced, removed, skipped: false };
  } catch (error) {
    logMirrorFailure('unable to reconcile the mirror', error);
    return { synced: 0, removed: 0, skipped: false };
  }
}
