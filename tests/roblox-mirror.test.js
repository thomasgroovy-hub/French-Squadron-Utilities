import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isRobloxMirrorConfigured,
  mirrorRobloxLink,
  reconcileRobloxMirror,
  unmirrorRobloxLink,
} from '../src/roblox-mirror.js';

/** Minimal recording stand-in for the bot's own pool. */
function sourcePool(rows) {
  const statements = [];
  return {
    statements,
    execute: async (query, params = []) => {
      statements.push({ sql: query.replace(/\s+/g, ' ').trim(), params });
      if (/^\s*SELECT/i.test(query)) {
        // A lookup filters on the user id; the reconcile reads the whole table.
        if (!params.length) return [[...rows]];
        const [userId] = params;
        return [rows.filter((row) => row.discord_user_id === userId)];
      }
      return [[]];
    },
  };
}

/** Minimal recording stand-in for the site's pool, with an in-memory table. */
function sitePool(initial = []) {
  const table = new Map(initial.map((row) => [row.discord_user_id, row]));
  const statements = [];

  return {
    table,
    statements,
    execute: async (query, params = []) => {
      const sql = query.replace(/\s+/g, ' ').trim();
      statements.push({ sql, params });
      if (/^CREATE TABLE/i.test(sql)) return [[]];
      if (/^INSERT INTO roblox_links/i.test(sql)) {
        const [discordUserId, verificationRank, robloxUserId, robloxUsername, verifiedAt] = params;
        table.set(discordUserId, {
          discord_user_id: discordUserId,
          verification_rank: verificationRank,
          roblox_user_id: robloxUserId,
          roblox_username: robloxUsername,
          verified_at: verifiedAt,
        });
        return [{ affectedRows: 1 }];
      }
      if (/^DELETE FROM roblox_links WHERE discord_user_id = \?$/i.test(sql)) {
        const removed = table.delete(params[0]) ? 1 : 0;
        return [{ affectedRows: removed }];
      }
      if (/^DELETE FROM roblox_links WHERE discord_user_id NOT IN/i.test(sql)) {
        const keep = new Set(params);
        let removed = 0;
        for (const key of [...table.keys()]) {
          if (!keep.has(key)) {
            table.delete(key);
            removed += 1;
          }
        }
        return [{ affectedRows: removed }];
      }
      if (/^DELETE FROM roblox_links$/i.test(sql)) {
        const removed = table.size;
        table.clear();
        return [{ affectedRows: removed }];
      }
      if (/^SELECT/i.test(sql)) return [[...table.values()]];
      return [[]];
    },
  };
}

const LINK = {
  discord_user_id: '111',
  verification_rank: 7,
  roblox_user_id: 999,
  roblox_username: 'Pilot',
  verified_at: '2026-01-01 10:00:00',
};

test('the mirror stays off until the site credentials are configured', () => {
  const saved = { ...process.env };
  for (const key of ['SITE_MYSQL_HOST', 'SITE_MYSQL_USER', 'SITE_MYSQL_PASSWORD', 'SITE_MYSQL_DATABASE']) {
    delete process.env[key];
  }
  try {
    assert.equal(isRobloxMirrorConfigured(), false);
  } finally {
    Object.assign(process.env, saved);
  }
});

test('mirroring a link copies the rank and the verification date', async () => {
  const site = sitePool();
  const ok = await mirrorRobloxLink('111', { pool: sourcePool([LINK]), sitePool: site });

  assert.equal(ok, true);
  assert.deepEqual(site.table.get('111'), LINK);
  const insert = site.statements.find((s) => /^INSERT INTO roblox_links/i.test(s.sql));
  assert.match(insert.sql, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(insert.params, ['111', 7, 999, 'Pilot', '2026-01-01 10:00:00']);
});

test('a re-link refreshes the mirror instead of duplicating it', async () => {
  const site = sitePool([{ ...LINK, roblox_username: 'OldName' }]);
  await mirrorRobloxLink('111', { pool: sourcePool([{ ...LINK, roblox_username: 'NewName' }]), sitePool: site });

  assert.equal(site.table.size, 1);
  assert.equal(site.table.get('111').roblox_username, 'NewName');
});

test('mirroring a member the bot no longer has removes the stale copy', async () => {
  const site = sitePool([LINK]);
  const ok = await mirrorRobloxLink('111', { pool: sourcePool([]), sitePool: site });

  assert.equal(ok, true);
  assert.equal(site.table.size, 0, 'the site must not keep a link the bot dropped');
});

test('unmirroring drops the copy so the site stops showing a verification', async () => {
  const site = sitePool([LINK]);
  const ok = await unmirrorRobloxLink('111', { sitePool: site });

  assert.equal(ok, true);
  assert.equal(site.table.size, 0);
});

test('a broken site database never breaks the bot verification flow', async () => {
  const failing = {
    execute: async () => { throw new Error('ER_BAD_FIELD_ERROR'); },
  };
  assert.equal(await mirrorRobloxLink('111', { pool: sourcePool([LINK]), sitePool: failing }), false);
  assert.equal(await unmirrorRobloxLink('111', { sitePool: failing }), false);
  assert.deepEqual(await reconcileRobloxMirror({ pool: sourcePool([LINK]), sitePool: failing }), {
    synced: 0,
    removed: 0,
    skipped: false,
  });
});

test('nothing happens when the site database is not configured', async () => {
  const saved = { ...process.env };
  for (const key of ['SITE_MYSQL_HOST', 'SITE_MYSQL_USER', 'SITE_MYSQL_PASSWORD', 'SITE_MYSQL_DATABASE']) {
    delete process.env[key];
  }
  try {
    assert.equal(await mirrorRobloxLink('111', { pool: sourcePool([LINK]) }), false);
    assert.equal(await unmirrorRobloxLink('111'), false);
    assert.deepEqual(await reconcileRobloxMirror({ pool: sourcePool([LINK]) }), { synced: 0, removed: 0, skipped: true });
  } finally {
    Object.assign(process.env, saved);
  }
});

test('reconciling backfills the whole table and removes what the bot dropped', async () => {
  const site = sitePool([
    { ...LINK, discord_user_id: '222', roblox_username: 'Stale' },
    { ...LINK, discord_user_id: '333', roblox_username: 'AlsoStale' },
  ]);
  const result = await reconcileRobloxMirror({
    pool: sourcePool([LINK, { ...LINK, discord_user_id: '444', verification_rank: 8 }]),
    sitePool: site,
  });

  assert.equal(result.skipped, false);
  assert.equal(result.synced, 2);
  assert.equal(result.removed, 2);
  assert.deepEqual([...site.table.keys()].sort(), ['111', '444']);
});

test('reconciling an empty bot table clears the mirror without invalid SQL', async () => {
  const site = sitePool([LINK]);
  const result = await reconcileRobloxMirror({ pool: sourcePool([]), sitePool: site });

  assert.equal(result.removed, 1);
  assert.equal(site.table.size, 0);
  // `NOT IN ()` is invalid SQL, so the empty case must not build that clause.
  assert.ok(site.statements.some((s) => /^DELETE FROM roblox_links$/i.test(s.sql)));
  assert.ok(!site.statements.some((s) => /NOT IN \(\s*\)/i.test(s.sql)));
});
