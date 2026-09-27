import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPermadeathNotificationIntegration,
  ensurePermadeathDeathsTable,
  extractDeathContext,
  extractRobloxUsername,
  PERMADEATH_DEATHS_TABLE,
} from '../src/permadeath-notifications.js';

const LINK = {
  discord_user_id: '123456789012345678',
  roblox_user_id: 987654321,
  roblox_username: 'Pilot_42',
};

/**
 * Mocked pool in the same spirit as the moderation tests: records every
 * statement so a test can assert what was sent and with which parameters.
 */
function createMockPool({ link = LINK, failInsert = null, failDdl = null } = {}) {
  const calls = { ddl: [], select: [], insert: [] };
  return {
    calls,
    query: async (sql) => {
      calls.ddl.push(sql);
      if (failDdl) throw new Error(failDdl);
      return [[]];
    },
    execute: async (sql, parameters) => {
      if (/SELECT discord_user_id/i.test(sql)) {
        calls.select.push(parameters);
        if (!link) return [[]];
        return [[link]];
      }
      if (new RegExp(`INSERT INTO ${PERMADEATH_DEATHS_TABLE}`, 'i').test(sql)) {
        calls.insert.push({ sql, parameters });
        if (failInsert) throw new Error(failInsert);
        return [{ insertId: 1, affectedRows: 1 }];
      }
      throw new Error(`Unexpected statement: ${sql}`);
    },
  };
}

function createMockClient({ sendFails = false } = {}) {
  const sent = [];
  const disconnected = [];
  return {
    sent,
    disconnected,
    client: {
      users: {
        fetch: async () => ({
          send: async (payload) => {
            if (sendFails) throw new Error('cannot send messages of this type');
            sent.push(payload);
          },
        }),
      },
      guilds: {
        cache: new Map([
          ['guild-1', {
            id: 'guild-1',
            voiceStates: {
              cache: new Map([['123456789012345678', {
                channelId: 'voice-1',
                disconnect: async (reason) => disconnected.push(reason),
              }]]),
            },
          }],
          ['guild-2', {
            id: 'guild-2',
            voiceStates: { cache: new Map() },
          }],
        ]),
      },
    },
  };
}

const PERMADEATH_MESSAGE = {
  id: 'message-1',
  channelId: '1546138245363007518',
  content: 'Pilot_42\nRoblox username: OtherUser',
  author: { bot: true },
  createdAt: new Date('2026-09-26T17:20:00.000Z'),
};

test('extracts only the first line as the Roblox username', () => {
  assert.equal(extractRobloxUsername('Pilot_42\nCause: @DifferentUser'), 'Pilot_42');
  assert.equal(extractRobloxUsername('\r\nPilot_42'), null);
  assert.equal(extractRobloxUsername('   Pilot_42   \r\nOther content'), 'Pilot_42');
  assert.equal(extractRobloxUsername(''), null);
});

test('treats everything after the username as death context', () => {
  assert.equal(extractDeathContext('Pilot_42\nKilled by\nFall damage'), 'Killed by\nFall damage');
  assert.equal(extractDeathContext('Pilot_42'), null);
  assert.equal(extractDeathContext('Pilot_42\n   \n  '), null);
  assert.equal(extractDeathContext(null), null);
  assert.equal(extractDeathContext(`Pilot_42\n${'x'.repeat(900)}`).length, 500);
});

test('processes a PK message once and sends an EmbedBuilder DM', async () => {
  const { client, sent, disconnected } = createMockClient();
  const pool = createMockPool();
  const integration = createPermadeathNotificationIntegration({ client, pool });
  const message = { ...PERMADEATH_MESSAGE };

  await integration.handleMessage(message);
  await integration.handleMessage(message);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds.length, 1);
  assert.equal(sent[0].embeds[0].data.footer.text, 'FPCS Utilities');
  assert.equal(sent[0].embeds[0].data.title, 'Tu es mort pendant une session roleplay !');
  assert.deepEqual(disconnected, ['Notification de mort envoyée']);
});

test('creates the death table with the columns the companion site reads', async () => {
  const pool = createMockPool();

  assert.equal(await ensurePermadeathDeathsTable(pool), true);
  assert.equal(pool.calls.ddl.length, 1);
  assert.match(pool.calls.ddl[0], /CREATE TABLE IF NOT EXISTS permadeath_deaths/);
  for (const column of [
    'discord_user_id VARCHAR(20) NOT NULL',
    'roblox_user_id VARCHAR(20) NOT NULL',
    'roblox_username VARCHAR(64) NULL',
    'event_id VARCHAR(64) NULL',
    'context TEXT NULL',
    'occurred_at DATETIME NOT NULL',
  ]) {
    assert.ok(
      pool.calls.ddl[0].includes(column),
      `DDL should declare ${column}`,
    );
  }
  assert.match(pool.calls.ddl[0], /UNIQUE KEY permadeath_deaths_event_uidx \(event_id\)/);
  assert.match(pool.calls.ddl[0], /INDEX permadeath_deaths_discord_idx \(discord_user_id\)/);
  assert.match(pool.calls.ddl[0], /INDEX permadeath_deaths_occurred_idx \(occurred_at\)/);
});

test('only issues the CREATE TABLE once per pool', async () => {
  const pool = createMockPool();

  await ensurePermadeathDeathsTable(pool);
  await ensurePermadeathDeathsTable(pool);

  assert.equal(pool.calls.ddl.length, 1);
});

test('INSERTs the death with the right params after a successful DM', async () => {
  const { client, sent } = createMockClient();
  const pool = createMockPool();
  const integration = createPermadeathNotificationIntegration({ client, pool });

  await integration.handleMessage({ ...PERMADEATH_MESSAGE });

  assert.equal(sent.length, 1, 'the DM must be sent');
  assert.equal(pool.calls.insert.length, 1, 'the death must be recorded');

  const parameters = pool.calls.insert[0].parameters;
  assert.equal(parameters.length, 6);
  assert.deepEqual(pool.calls.select[0], ['Pilot_42']);
  assert.equal(parameters[0], '123456789012345678');
  assert.equal(parameters[1], '987654321', 'roblox_user_id is stored as a string');
  assert.equal(parameters[2], 'Pilot_42');
  assert.equal(parameters[3], 'message-1', 'the Discord message id is the event id');
  assert.equal(parameters[4], 'Roblox username: OtherUser');
  assert.deepEqual(parameters[5], PERMADEATH_MESSAGE.createdAt);
  assert.match(pool.calls.insert[0].sql, /ON DUPLICATE KEY UPDATE/);
});

test('a database failure never blocks the DM', async () => {
  const { client, sent, disconnected } = createMockClient();
  const pool = createMockPool({ failInsert: 'table is read-only' });
  const integration = createPermadeathNotificationIntegration({ client, pool });

  await assert.doesNotReject(() => integration.handleMessage({ ...PERMADEATH_MESSAGE }));

  assert.equal(sent.length, 1, 'the DM must still be delivered');
  assert.deepEqual(disconnected, ['Notification de mort envoyée']);
});

test('a DM failure still records the death and skips the voice disconnect', async () => {
  const { client, sent, disconnected } = createMockClient({ sendFails: true });
  const pool = createMockPool();
  const integration = createPermadeathNotificationIntegration({ client, pool });

  await assert.doesNotReject(() => integration.handleMessage({ ...PERMADEATH_MESSAGE }));

  assert.equal(sent.length, 0, 'the DM is expected to fail');
  assert.equal(pool.calls.insert.length, 1, 'the death must still be recorded');
  assert.equal(pool.calls.insert[0].parameters[0], '123456789012345678');
  assert.deepEqual(disconnected, [], 'no voice disconnect when the DM failed');
});

test('a failing CREATE TABLE is logged and does not throw', async () => {
  const pool = createMockPool({ failDdl: 'CREATE command denied' });

  assert.equal(await ensurePermadeathDeathsTable(pool), false);
});

test('logs and stops when the database lookup fails', async () => {
  const client = { users: { fetch: async () => { throw new Error('must not fetch'); } } };
  const integration = createPermadeathNotificationIntegration({
    client,
    pool: {
      execute: async () => { throw new Error('database offline'); },
    },
  });

  await assert.doesNotReject(() => integration.handleMessage({
    id: 'message-2',
    channelId: '1546138245363007518',
    content: 'Pilot_42\nOther content',
    author: { bot: false },
  }));
});

test('does nothing when no Roblox link matches', async () => {
  const { client, sent } = createMockClient();
  const pool = createMockPool({ link: null });
  const integration = createPermadeathNotificationIntegration({ client, pool });

  await integration.handleMessage({ ...PERMADEATH_MESSAGE, id: 'message-3' });

  assert.equal(sent.length, 0);
  assert.equal(pool.calls.insert.length, 0);
});

test('ignores messages from other channels', async () => {
  const { client } = createMockClient();
  const pool = createMockPool();
  const integration = createPermadeathNotificationIntegration({ client, pool });

  await integration.handleMessage({ ...PERMADEATH_MESSAGE, id: 'message-4', channelId: 'other' });

  assert.equal(pool.calls.select.length, 0);
  assert.equal(pool.calls.insert.length, 0);
});
