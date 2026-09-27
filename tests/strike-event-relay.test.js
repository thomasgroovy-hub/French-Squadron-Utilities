import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createStrikeEventRelay,
  createStrikeEventEmbed,
  ensureStrikeEventsTable,
  STRIKE_LOG_CHANNEL_ID,
} from '../src/strike-event-relay.js';

function createMockPool({ rows = [], affected = 1 } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql) => {
      calls.push({ kind: 'query', sql });
      return [[]];
    },
    execute: async (sql, params) => {
      calls.push({ kind: 'execute', sql, params });
      if (/SELECT/.test(sql)) return [rows];
      return [{ affectedRows: affected }];
    },
  };
}

const CREATED_EVENT = {
  id: 1,
  strike_id: 7,
  action: 'created',
  target_discord_id: '1549824549250539634',
  target_name: 'Membre Test',
  actor_discord_id: '539089957730648065',
  actor_name: 'Modérateur',
  previous_reason: null,
  new_reason: 'Harcèlement en vocal',
  created_at: new Date('2024-05-01T10:00:00Z'),
};

test('relay reads only un-relayed rows, oldest first', async () => {
  const pool = createMockPool({ rows: [CREATED_EVENT] });
  const sent = [];
  const relay = createStrikeEventRelay({
    client: { channels: { fetch: async () => ({ isTextBased: () => true, send: async (p) => sent.push(p) }) } },
    pool,
    channelId: '123',
  });

  const relayed = await relay.relayPendingEvents();

  assert.equal(relayed, 1);
  const select = pool.calls.find((c) => c.kind === 'execute' && /SELECT/.test(c.sql));
  assert.match(select.sql, /WHERE relayed_at IS NULL/);
  assert.match(select.sql, /ORDER BY id ASC/);
});

test('relay marks a row only after Discord accepted it', async () => {
  const pool = createMockPool({ rows: [CREATED_EVENT] });
  const relay = createStrikeEventRelay({
    client: { channels: { fetch: async () => ({ isTextBased: () => true, send: async () => {} }) } },
    pool,
    channelId: '123',
  });

  await relay.relayPendingEvents();

  const update = pool.calls.find((c) => c.kind === 'execute' && /UPDATE/.test(c.sql));
  assert.ok(update, 'the audit row must be stamped as relayed');
  assert.match(update.sql, /SET relayed_at = CURRENT_TIMESTAMP/);
  assert.deepEqual(update.params, [1]);
});

test('a Discord failure leaves the audit row for a later retry', async () => {
  const pool = createMockPool({ rows: [CREATED_EVENT] });
  let attempts = 0;
  const relay = createStrikeEventRelay({
    client: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async () => {
            attempts += 1;
            throw new Error('Missing Permissions');
          },
        }),
      },
    },
    pool,
    channelId: '123',
  });

  const relayed = await relay.relayPendingEvents();

  assert.equal(relayed, 0);
  assert.equal(attempts, 1);
  assert.ok(
    !pool.calls.some((c) => c.kind === 'execute' && /UPDATE/.test(c.sql)),
    'a failed send must not mark the row as relayed',
  );
});

test('an unreachable channel is an error, not a crash', async () => {
  const pool = createMockPool({ rows: [CREATED_EVENT] });
  const relay = createStrikeEventRelay({
    client: { channels: { fetch: async () => null } },
    pool,
    channelId: '123',
  });

  assert.equal(await relay.relayPendingEvents(), 0);
});

test('the relay stops after a failure instead of skipping ahead', async () => {
  const pool = createMockPool({
    rows: [
      CREATED_EVENT,
      { ...CREATED_EVENT, id: 2 },
      { ...CREATED_EVENT, id: 3 },
    ],
  });
  let attempts = 0;
  const relay = createStrikeEventRelay({
    client: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async () => {
            attempts += 1;
            if (attempts === 2) throw new Error('rate limited');
          },
        }),
      },
    },
    pool,
    channelId: '123',
  });

  const relayed = await relay.relayPendingEvents();

  assert.equal(relayed, 1);
  assert.equal(attempts, 2, 'must break out of the batch, not continue to id 3');
});

test('embed names the action, the member and the acting user, and pings nobody', async () => {
  const pool = createMockPool({ rows: [CREATED_EVENT] });
  let payload = null;
  const relay = createStrikeEventRelay({
    client: { channels: { fetch: async () => ({ isTextBased: () => true, send: async (p) => { payload = p; } }) } },
    pool,
    channelId: '123',
  });

  await relay.relayPendingEvents();

  assert.equal(payload.allowedMentions.parse.length, 0);
  const embed = payload.embeds[0];
  const rendered = JSON.stringify(embed);
  assert.match(rendered, /Avertissement ajout/);
  assert.match(rendered, /Modérateur/);
  assert.match(rendered, /Membre Test/);
  assert.match(rendered, /Harcèlement en vocal/);
});

test('an edit shows both the old and the new reason', () => {
  const embed = createStrikeEventEmbed({
    ...CREATED_EVENT,
    action: 'updated',
    previous_reason: 'Ancienne raison',
    new_reason: 'Nouvelle raison',
  });
  const rendered = JSON.stringify(embed);
  assert.match(rendered, /Ancienne raison/);
  assert.match(rendered, /Nouvelle raison/);
});

test('a deletion still shows the reason that was removed', () => {
  const embed = createStrikeEventEmbed({
    ...CREATED_EVENT,
    action: 'deleted',
    previous_reason: 'Raison effacée',
    new_reason: null,
  });
  const rendered = JSON.stringify(embed);
  assert.match(rendered, /Avertissement supprim/);
  assert.match(rendered, /Raison effacée/);
});

test('an unknown action still renders instead of throwing', () => {
  const embed = createStrikeEventEmbed({ ...CREATED_EVENT, action: 'bogus' });
  assert.ok(embed);
});

test('the DDL creates relayed_at so a restart cannot re-send history', async () => {
  const pool = createMockPool();
  assert.equal(await ensureStrikeEventsTable(pool), true);
  const ddl = pool.calls.find((c) => c.kind === 'query').sql;
  assert.match(ddl, /relayed_at DATETIME NULL/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS strike_events/);
});

test('the relay defaults to the committee channel', () => {
  assert.equal(STRIKE_LOG_CHANNEL_ID, '1546193398388494336');
});
