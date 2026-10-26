import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityType } from 'discord.js';

import {
  buildActivityStatus,
  createVoiceActivityIntegration,
  formatDurationFr,
} from '../src/voice-activity.js';
import { ACTIVITY_ROLE_ID } from '../src/permissions.js';

const CHANNEL_ID = '1561485674149060689';
const RPC_IMAGE = '182D7D51-2F44-477A-8505-AC972CF2E8ED';
const NOW = Date.parse('2026-10-19T12:00:00Z');

function memberEntry(username, { activity = null, joinedAt = null } = {}) {
  return { userId: `id-${username}`, username, activity, joinedAt };
}

function createMockClient({
  guildChannels = [],
  memberRoles = {},
  administrators = [],
} = {}) {
  const presencePackets = [];
  const handlers = new Map();

  const guilds = guildChannels.map(({ channelId, members = [] }, index) => {
    const memberMap = new Map(
      members.map((m) => [
        m.id,
        {
          id: m.id,
          user: {
            id: m.id,
            username: m.username,
            globalName: m.globalName ?? m.username,
            bot: m.bot ?? false,
          },
        },
      ])
    );

    return {
      id: `guild-${index}`,
      members: {
        fetch: async (userId) => ({
          id: userId,
          roles: { cache: new Set(memberRoles[userId] ?? []) },
          permissions: { has: () => administrators.includes(userId) },
        }),
      },
      channels: {
        cache: new Map([
          [
            channelId,
            {
              id: channelId,
              members: memberMap,
            },
          ],
        ]),
      },
    };
  });

  const fallbackGuild = {
    id: 'guild-0',
    members: {
      fetch: async (userId) => ({
        id: userId,
        roles: { cache: new Set(memberRoles[userId] ?? []) },
        permissions: { has: () => administrators.includes(userId) },
      }),
    },
    channels: { cache: new Map() },
  };

  const guildCache = new Map(guilds.map((guild) => [guild.id, guild]));
  if (!guildCache.has('guild-0')) guildCache.set('guild-0', fallbackGuild);

  return {
    presencePackets,
    handlers,
    user: {
      id: 'bot-id',
    },
    presence: { status: 'online' },
    ws: {
      broadcast: (packet) => {
        presencePackets.push(packet);
      },
    },
    guilds: {
      cache: guildCache,
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
}

function lastActivity(client) {
  const packet = client.presencePackets.at(-1);
  return packet?.d?.activities?.[0] ?? null;
}

function voiceState(id, channelId, { bot = false, username = id } = {}) {
  return {
    id,
    channelId,
    member: {
      user: {
        id,
        username,
        globalName: username,
        bot,
      },
    },
  };
}

function createIntegration(client, overrides = {}) {
  return createVoiceActivityIntegration({
    client,
    channelId: CHANNEL_ID,
    now: () => NOW,
    refreshMs: 0,
    reconnectDelayMs: 0,
    ...overrides,
  });
}

test('formatDurationFr renders readable French durations', () => {
  assert.equal(formatDurationFr(0), "moins d'une minute");
  assert.equal(formatDurationFr(59_000), "moins d'une minute");
  assert.equal(formatDurationFr(60_000), '1 minute');
  assert.equal(formatDurationFr(5 * 60_000), '5 minutes');
  assert.equal(formatDurationFr(60 * 60_000), '1 heure');
  assert.equal(formatDurationFr(65 * 60_000), '1 heure et 5 minutes');
  assert.equal(formatDurationFr(25 * 60 * 60_000), '1 jour et 1 heure');
  assert.equal(formatDurationFr(49 * 60 * 60_000), '2 jours et 1 heure');
});

test('buildActivityStatus: empty channel clears the status', () => {
  assert.equal(buildActivityStatus({ members: [], now: NOW }), null);
});

test('buildActivityStatus: one aurafarmer shows username and duration', () => {
  const text = buildActivityStatus({
    members: [memberEntry('Alice', {
      activity: 'aurafarm',
      joinedAt: NOW - 5 * 60_000,
    })],
    now: NOW,
  });
  assert.equal(text, "Alice est en train d'aurafarm depuis 5 minutes");
});

test('buildActivityStatus: one aurafarmer with unknown join omits duration', () => {
  const text = buildActivityStatus({
    members: [memberEntry('Alice', { activity: 'aurafarm', joinedAt: null })],
    now: NOW,
  });
  assert.equal(text, "Alice est en train d'aurafarm");
});

test('buildActivityStatus: one developer shows the development text', () => {
  const text = buildActivityStatus({
    members: [memberEntry('Alice', { activity: 'development' })],
    now: NOW,
  });
  assert.equal(text, 'Alice est en train de développer');
});

test('buildActivityStatus: one member with no declared activity uses the neutral fallback', () => {
  const text = buildActivityStatus({
    members: [memberEntry('Alice')],
    now: NOW,
  });
  assert.equal(text, "Alice est en train de voc'");
});

test('buildActivityStatus: two aurafarmers use the later join timestamp', () => {
  const text = buildActivityStatus({
    members: [
      memberEntry('Alice', {
        activity: 'aurafarm',
        joinedAt: NOW - 20 * 60_000,
      }),
      memberEntry('Bob', {
        activity: 'aurafarm',
        joinedAt: NOW - 8 * 60_000,
      }),
    ],
    now: NOW,
  });
  assert.equal(
    text,
    "Alice et Bob sont en train d'aurafarm depuis 8 minutes"
  );
});

test('buildActivityStatus: two developers are announced together', () => {
  const text = buildActivityStatus({
    members: [
      memberEntry('Alice', { activity: 'development' }),
      memberEntry('Bob', { activity: 'development' }),
    ],
    now: NOW,
  });
  assert.equal(text, 'Alice et Bob sont en train de développer');
});

test('buildActivityStatus: mixed activities use the neutral fallback', () => {
  const text = buildActivityStatus({
    members: [
      memberEntry('Alice', {
        activity: 'aurafarm',
        joinedAt: NOW - 5 * 60_000,
      }),
      memberEntry('Bob', { activity: 'development' }),
    ],
    now: NOW,
  });
  assert.equal(text, "Quelqu'un est en train de voc'");
});

test('buildActivityStatus: aurafarmer plus unknown activity uses the neutral fallback', () => {
  const text = buildActivityStatus({
    members: [
      memberEntry('Alice', {
        activity: 'aurafarm',
        joinedAt: NOW - 5 * 60_000,
      }),
      memberEntry('Bob'),
    ],
    now: NOW,
  });
  assert.equal(text, "Quelqu'un est en train de voc'");
});

test('buildActivityStatus: three aurafarmers collapse to the plural form', () => {
  const text = buildActivityStatus({
    members: [
      memberEntry('Alice', { activity: 'aurafarm' }),
      memberEntry('Bob', { activity: 'aurafarm' }),
      memberEntry('Carol', { activity: 'aurafarm' }),
    ],
    now: NOW,
  });
  assert.equal(text, "Plusieurs personnes sont en train d'aurafarm");
});

test('buildActivityStatus: three developers collapse to the plural form', () => {
  const text = buildActivityStatus({
    members: [
      memberEntry('Alice', { activity: 'development' }),
      memberEntry('Bob', { activity: 'development' }),
      memberEntry('Carol', { activity: 'development' }),
    ],
    now: NOW,
  });
  assert.equal(text, 'Plusieurs personnes sont en train de développer');
});

test('buildActivityStatus: three users with a development majority follow the majority', () => {
  const text = buildActivityStatus({
    members: [
      memberEntry('Alice', { activity: 'aurafarm' }),
      memberEntry('Bob', { activity: 'development' }),
      memberEntry('Carol', { activity: 'development' }),
    ],
    now: NOW,
  });
  assert.equal(text, 'Plusieurs personnes sont en train de développer');
});

test('buildActivityStatus: three-way tie uses the neutral fallback', () => {
  const text = buildActivityStatus({
    members: [
      memberEntry('Alice', { activity: 'aurafarm' }),
      memberEntry('Bob', { activity: 'development' }),
      memberEntry('Carol'),
    ],
    now: NOW,
  });
  assert.equal(text, "Plusieurs personnes sont en train de voc'");
});

test('voiceStateUpdate: a join starts tracking and pushes the status', async () => {
  const client = createMockClient();
  const integration = createIntegration(client);
  integration.start();

  await integration.handleVoiceStateUpdate(
    voiceState('u1', null, { username: 'Alice' }),
    voiceState('u1', CHANNEL_ID, { username: 'Alice' })
  );

  assert.equal(integration.members.size, 1);
  assert.equal(client.presencePackets.length, 1);

  const activity = lastActivity(client);
  assert.equal(activity.type, ActivityType.Watching);
  assert.equal(activity.name, "Alice est en train de voc'");
  assert.equal(activity.assets.large_image, RPC_IMAGE);
});

test('voiceStateUpdate: bots are ignored', async () => {
  const client = createMockClient();
  const integration = createIntegration(client);
  integration.start();

  await integration.handleVoiceStateUpdate(
    voiceState('bot1', null, { username: 'Robotos', bot: true }),
    voiceState('bot1', CHANNEL_ID, { username: 'Robotos', bot: true })
  );

  assert.equal(integration.members.size, 0);
  assert.equal(client.presencePackets.length, 0);
});

test('voiceStateUpdate: a move into the trigger channel counts as a join, out counts as a leave', async () => {
  const client = createMockClient();
  const integration = createIntegration(client);
  integration.start();

  await integration.handleVoiceStateUpdate(
    voiceState('u1', 'other-channel', { username: 'Alice' }),
    voiceState('u1', CHANNEL_ID, { username: 'Alice' })
  );
  assert.equal(integration.members.size, 1);

  await integration.handleVoiceStateUpdate(
    voiceState('u1', CHANNEL_ID, { username: 'Alice' }),
    voiceState('u1', 'other-channel', { username: 'Alice' })
  );
  assert.equal(integration.members.size, 0);
  assert.equal(lastActivity(client).name, 'I love you');
});

test('voiceStateUpdate: a leave resets the join timestamp so a rejoin restarts the duration', async () => {
  const client = createMockClient();
  const integration = createIntegration(client);
  integration.declaredActivities.set('u1', 'aurafarm');
  integration.start();

  await integration.handleVoiceStateUpdate(
    voiceState('u1', null, { username: 'Alice' }),
    voiceState('u1', CHANNEL_ID, { username: 'Alice' })
  );
  const firstJoin = integration.members.get('u1').joinedAt;
  assert.ok(Number.isFinite(firstJoin));

  await integration.handleVoiceStateUpdate(
    voiceState('u1', CHANNEL_ID, { username: 'Alice' }),
    voiceState('u1', null, { username: 'Alice' })
  );

  await integration.handleVoiceStateUpdate(
    voiceState('u1', null, { username: 'Alice' }),
    voiceState('u1', CHANNEL_ID, { username: 'Alice' })
  );
  assert.ok(Number.isFinite(integration.members.get('u1').joinedAt));
});

test('syncFromVoiceStates: rebuilds membership after a restart without inventing timestamps', async () => {
  const client = createMockClient({
    guildChannels: [
      {
        channelId: CHANNEL_ID,
        members: [
          { id: 'u1', username: 'Alice' },
          { id: 'bot1', username: 'Robotos', bot: true },
        ],
      },
    ],
  });
  const integration = createIntegration(client);
  integration.declaredActivities.set('u1', 'aurafarm');

  integration.syncFromVoiceStates();
  await integration.applyStatus();

  assert.equal(integration.members.size, 1);
  assert.equal(integration.members.get('u1').joinedAt, null);
  assert.equal(client.presencePackets.length, 1);
  assert.equal(lastActivity(client).name, "Alice est en train d'aurafarm");
});

test('applyStatus: skips redundant updates when nothing changed', async () => {
  const client = createMockClient();
  const integration = createIntegration(client);

  await integration.handleVoiceStateUpdate(
    voiceState('u1', null, { username: 'Alice' }),
    voiceState('u1', CHANNEL_ID, { username: 'Alice' })
  );
  const firstCallCount = client.presencePackets.length;

  const changed = await integration.applyStatus();
  assert.equal(changed, false);
  assert.equal(client.presencePackets.length, firstCallCount);
});

test('applyStatus: shows the rotating placeholder when the channel empties', async () => {
  const client = createMockClient();
  const integration = createIntegration(client);

  await integration.handleVoiceStateUpdate(
    voiceState('u1', null, { username: 'Alice' }),
    voiceState('u1', CHANNEL_ID, { username: 'Alice' })
  );
  await integration.handleVoiceStateUpdate(
    voiceState('u1', CHANNEL_ID, { username: 'Alice' }),
    voiceState('u1', null, { username: 'Alice' })
  );

  const activity = lastActivity(client);
  assert.equal(activity.name, 'I love you');
  assert.equal(activity.type, ActivityType.Watching);
  assert.equal(activity.assets.large_image, RPC_IMAGE);
});

test('applyStatus: the placeholder rotates every 5 minutes to let the bot cool down', async () => {
  let current = NOW;
  const client = createMockClient();
  const integration = createVoiceActivityIntegration({
    client,
    channelId: CHANNEL_ID,
    now: () => current,
    refreshMs: 0,
    reconnectDelayMs: 0,
  });

  assert.equal(await integration.applyStatus(), true);
  assert.equal(lastActivity(client).name, 'I love you');

  current = NOW + 4 * 60_000;
  assert.equal(await integration.applyStatus(), false);

  current = NOW + 5 * 60_000;
  assert.equal(await integration.applyStatus(), true);
  assert.equal(
    lastActivity(client).name,
    "There might be a time where you wouldn't see me"
  );

  current = NOW + 10 * 60_000;
  assert.equal(await integration.applyStatus(), true);
  assert.equal(lastActivity(client).name, 'Est-ce que des gens lisent ça ?');

  current = NOW + 15 * 60_000;
  assert.equal(await integration.applyStatus(), true);
  assert.equal(lastActivity(client).name, 'I love you');
});

test('applyStatus: a configured default name overrides the rotating placeholder', async () => {
  const client = createMockClient();
  const integration = createIntegration(client, {
    defaultActivityName: 'En ligne',
  });

  await integration.applyStatus();

  assert.equal(lastActivity(client).name, 'En ligne');
});

test('handleInteraction: /activity sets, updates and clears the declared activity', async () => {
  const client = createMockClient({
    memberRoles: { u1: [ACTIVITY_ROLE_ID] },
  });
  const integration = createIntegration(client);

  const makeInteraction = (statut, userId = 'u1') => ({
    isChatInputCommand: () => true,
    commandName: 'activity',
    guildId: 'guild-0',
    user: { id: userId, tag: `${userId}#0001` },
    options: {
      getString: (name, required) => {
        assert.equal(name, 'statut');
        assert.equal(required, true);
        return statut;
      },
    },
    reply: async () => {},
  });

  assert.equal(
    await integration.handleInteraction(makeInteraction('aurafarm')),
    true
  );
  assert.equal(integration.declaredActivities.get('u1'), 'aurafarm');

  assert.equal(
    await integration.handleInteraction(makeInteraction('development')),
    true
  );
  assert.equal(integration.declaredActivities.get('u1'), 'development');

  assert.equal(
    await integration.handleInteraction(makeInteraction('stop')),
    true
  );
  assert.equal(integration.declaredActivities.has('u1'), false);

  assert.equal(
    await integration.handleInteraction({
      isChatInputCommand: () => true,
      commandName: 'ping',
    }),
    false
  );
});

test('handleInteraction: /activity is denied without the activity role', async () => {
  const client = createMockClient({ memberRoles: { u1: [] } });
  const integration = createIntegration(client);

  const replies = [];
  const handled = await integration.handleInteraction({
    isChatInputCommand: () => true,
    commandName: 'activity',
    guildId: 'guild-0',
    user: { id: 'u1', tag: 'u1#0001' },
    options: { getString: () => 'aurafarm' },
    reply: async (payload) => {
      replies.push(payload);
    },
  });

  assert.equal(handled, true);
  assert.equal(integration.declaredActivities.has('u1'), false);
  assert.equal(replies.length, 1);
  assert.ok(replies[0].flags & (1 << 6), 'the refusal must be ephemeral');
});

test('handleInteraction: declaring an activity while in the channel refreshes the status immediately', async () => {
  const client = createMockClient({
    memberRoles: { u1: [ACTIVITY_ROLE_ID] },
  });
  const integration = createIntegration(client);

  await integration.handleVoiceStateUpdate(
    voiceState('u1', null, { username: 'Alice' }),
    voiceState('u1', CHANNEL_ID, { username: 'Alice' })
  );
  const before = lastActivity(client);
  assert.equal(before.name, "Alice est en train de voc'");

  await integration.handleInteraction({
    isChatInputCommand: () => true,
    commandName: 'activity',
    guildId: 'guild-0',
    user: { id: 'u1', tag: 'u1#0001' },
    options: { getString: () => 'development' },
    reply: async () => {},
  });

  const after = lastActivity(client);
  assert.equal(after.name, 'Alice est en train de développer');
});
