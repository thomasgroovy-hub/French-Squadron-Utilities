import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPermadeathNotificationIntegration,
  extractRobloxUsername,
} from '../src/permadeath-notifications.js';

test('extracts only the first line as the Roblox username', () => {
  assert.equal(extractRobloxUsername('Pilot_42\nCause: @DifferentUser'), 'Pilot_42');
  assert.equal(extractRobloxUsername('\r\nPilot_42'), null);
  assert.equal(extractRobloxUsername('   Pilot_42   \r\nOther content'), 'Pilot_42');
  assert.equal(extractRobloxUsername(''), null);
});

test('processes a PK message once and sends an EmbedBuilder DM', async () => {
  const sent = [];
  const disconnected = [];
  const client = {
    users: {
      fetch: async () => ({
        send: async (payload) => sent.push(payload),
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
          voiceStates: {
            cache: new Map(),
          },
        }],
      ]),
    },
  };
  const integration = createPermadeathNotificationIntegration({
    client,
    pool: {
      execute: async (query, parameters) => {
        assert.match(query, /LOWER\(roblox_username\) = LOWER\(\?\)/);
        assert.deepEqual(parameters, ['Pilot_42']);
        return [[{ discord_user_id: '123456789012345678' }]];
      },
    },
  });
  const message = {
    id: 'message-1',
    channelId: '1546138245363007518',
    content: 'Pilot_42\nRoblox username: OtherUser',
    author: { bot: true },
  };

  await integration.handleMessage(message);
  await integration.handleMessage(message);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].embeds.length, 1);
  assert.equal(sent[0].embeds[0].data.footer.text, 'FPCS Utilities');
  assert.equal(sent[0].embeds[0].data.title, 'Tu es mort pendant une session roleplay !');
  assert.deepEqual(disconnected, ['Notification de mort envoyée']);
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