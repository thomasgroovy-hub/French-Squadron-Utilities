import { ActivityType, Events, SlashCommandBuilder } from 'discord.js';
import { GatewayOpcodes } from 'discord-api-types/v10';
import { createV2EphemeralError, createV2Message } from './components.js';
import { ACTIVITY_ROLE_ID, hasGuildPermission } from './permissions.js';

export const DEFAULT_TRIGGER_CHANNEL_ID = '1561485674149060689';

export const ACTIVITY_AURAFARM = 'aurafarm';
export const ACTIVITY_DEVELOPMENT = 'development';

const ACTIVITY_TEXT_LIMIT = 128;
const DEFAULT_REFRESH_MS = 60_000;
const DEFAULT_RECONNECT_DELAY_MS = 2_000;

// Rich presence defaults: the image must be uploaded to the application's
// Rich Presence assets in the Discord Developer Portal.
const DEFAULT_RICH_PRESENCE_IMAGE = '182d7d51-2f44-477a-8505-ac972cf2e8ed';

const DEFAULT_PLACEHOLDER_TEXTS = [
  'Saying something stupid like I love you',
  "There might be a time where you wouldn't see me",
  'Est-ce que des gens lisent ça ?',
];
const DEFAULT_PLACEHOLDER_ROTATE_MS = 5 * 60_000;

export const voiceActivityCommands = [
  new SlashCommandBuilder()
    .setName('activity')
    .setDescription('Déclare ton activité affichée sur le statut du bot.')
    .addStringOption((option) =>
      option
        .setName('statut')
        .setDescription('Activité reflétée par le statut du bot en vocal.')
        .setRequired(true)
        .addChoices(
          { name: 'Aurafarm', value: ACTIVITY_AURAFARM },
          { name: 'Développement', value: ACTIVITY_DEVELOPMENT },
          { name: 'Arrêter', value: 'stop' },
        )),
];

export function formatDurationFr(milliseconds) {
  const clamped = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : 0;
  const totalMinutes = Math.floor(clamped / 60_000);

  if (totalMinutes < 1) return "moins d'une minute";

  const minutes = totalMinutes % 60;
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  const parts = [];
  if (days > 0) parts.push(`${days} jour${days > 1 ? 's' : ''}`);
  if (hours > 0) parts.push(`${hours} heure${hours > 1 ? 's' : ''}`);
  if (days === 0 && minutes > 0) {
    parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
  }

  return parts.join(' et ');
}

export function buildActivityStatus({ members, now }) {
  if (!members || members.length === 0) return null;

  const aurafarmers = members.filter((m) => m.activity === ACTIVITY_AURAFARM);
  const developers = members.filter((m) => m.activity === ACTIVITY_DEVELOPMENT);
  const unknown = members.length - aurafarmers.length - developers.length;

  if (members.length === 1) {
    const member = members[0];
    if (member.activity === ACTIVITY_AURAFARM) {
      if (Number.isFinite(member.joinedAt)) {
        return `${member.username} est en train d'aurafarm depuis ${formatDurationFr(now - member.joinedAt)}`;
      }
      return `${member.username} est en train d'aurafarm`;
    }
    if (member.activity === ACTIVITY_DEVELOPMENT) {
      return `${member.username} est en train de développer`;
    }
    return `${member.username} est en train de voc'`;
  }

  if (members.length === 2) {
    const pairLabel = `${members[0].username} et ${members[1].username}`;
    if (aurafarmers.length === 2) {
      const base = `${pairLabel} sont en train d'aurafarm`;
      const joinTimestamps = aurafarmers
        .map((m) => m.joinedAt)
        .filter((value) => Number.isFinite(value));
      if (joinTimestamps.length === 2) {
        const laterJoin = Math.max(...joinTimestamps);
        return `${base} depuis ${formatDurationFr(now - laterJoin)}`;
      }
      return base;
    }
    if (developers.length === 2) {
      return `${pairLabel} sont en train de développer`;
    }
    return "Quelqu'un est en train de voc'";
  }

  if (
    aurafarmers.length > developers.length &&
    aurafarmers.length > unknown
  ) {
    return "Plusieurs personnes sont en train d'aurafarm";
  }
  if (
    developers.length > aurafarmers.length &&
    developers.length > unknown
  ) {
    return 'Plusieurs personnes sont en train de développer';
  }
  return "Plusieurs personnes sont en train de voc'";
}

function displayNameOf(user, fallback) {
  return user?.globalName || user?.username || fallback;
}

export function createVoiceActivityIntegration({
  client,
  channelId = process.env.VOICE_ACTIVITY_CHANNEL_ID || DEFAULT_TRIGGER_CHANNEL_ID,
  defaultActivityName = process.env.VOICE_ACTIVITY_DEFAULT_NAME || null,
  placeholderTexts = DEFAULT_PLACEHOLDER_TEXTS,
  placeholderRotateMs = Number(process.env.VOICE_ACTIVITY_ROTATE_MS) || DEFAULT_PLACEHOLDER_ROTATE_MS,
  richPresenceImage = process.env.VOICE_ACTIVITY_RPC_IMAGE || DEFAULT_RICH_PRESENCE_IMAGE,
  richPresenceLargeText = process.env.VOICE_ACTIVITY_RPC_LARGE_TEXT || null,
  richPresenceState = process.env.VOICE_ACTIVITY_RPC_STATE || null,
  now = () => Date.now(),
  refreshMs = Number(process.env.VOICE_ACTIVITY_REFRESH_MS) || DEFAULT_REFRESH_MS,
  reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
} = {}) {
  const members = new Map();
  const declaredActivities = new Map();

  const placeholderPool = (defaultActivityName
    ? [String(defaultActivityName)]
    : placeholderTexts
  ).filter((text) => typeof text === 'string' && text.length > 0);
  const rotationMs = placeholderRotateMs > 0
    ? placeholderRotateMs
    : DEFAULT_PLACEHOLDER_ROTATE_MS;

  let lastPushedKey = null;
  let pushedAnything = false;
  let placeholderStartedAt = null;
  let refreshTimer = null;
  let reconnectTimer = null;

  // The sentence must live in `name`: for a Watching activity the visible
  // status is only "Watching <name>", `details` is not shown in the member
  // list, so putting it there made every update invisible.
  function desiredPayload() {
    const text = buildActivityStatus({ members: [...members.values()], now: now() });
    if (text) {
      placeholderStartedAt = null;
      return { kind: 'rpc', name: text.slice(0, ACTIVITY_TEXT_LIMIT) };
    }

    if (placeholderPool.length === 0) return { kind: 'cleared' };

    if (placeholderStartedAt === null) {
      placeholderStartedAt = now();
    }
    const elapsed = Math.max(0, now() - placeholderStartedAt);
    const index = Math.floor(elapsed / rotationMs) % placeholderPool.length;
    return { kind: 'rpc', name: placeholderPool[index].slice(0, ACTIVITY_TEXT_LIMIT) };
  }

  function buildRichPresenceActivity(name) {
    const activity = {
      name,
      type: ActivityType.Watching,
      instance: true,
      assets: {},
    };

    if (richPresenceState) {
      activity.state = richPresenceState.slice(0, ACTIVITY_TEXT_LIMIT);
    }
    if (richPresenceImage) {
      activity.assets.large_image = richPresenceImage;
    }
    if (richPresenceLargeText) {
      activity.assets.large_text = richPresenceLargeText;
    }

    return activity;
  }

  // discord.js' ClientPresence only forwards type/name/state/url, which drops
  // rich presence assets. Broadcast the raw PresenceUpdate packet instead so
  // the RPC image is actually shown on the bot profile.
  function pushPayload(payload) {
    const activities = payload.kind === 'rpc'
      ? [buildRichPresenceActivity(payload.name)]
      : [];

    client.ws.broadcast({
      op: GatewayOpcodes.PresenceUpdate,
      d: {
        since: null,
        activities,
        status: client.presence?.status ?? 'online',
        afk: false,
      },
    });

    if (payload.kind === 'rpc') {
      console.log(`[VoiceActivity] Presence -> Watching ${payload.name}`);
    } else {
      console.log('[VoiceActivity] Presence -> cleared');
    }
  }

  async function applyStatus() {
    const payload = desiredPayload();
    const key = JSON.stringify(payload);
    if (pushedAnything && key === lastPushedKey) return false;

    try {
      await pushPayload(payload);
      lastPushedKey = key;
      pushedAnything = true;
      return true;
    } catch (error) {
      console.error(
        '[VoiceActivity] Unable to update the bot activity:',
        error?.message ?? error
      );
      return false;
    }
  }

  function invalidateCache() {
    pushedAnything = false;
    lastPushedKey = null;
  }

  function isIgnoredUser(userId, member) {
    if (member?.user?.bot) return true;
    if (client.user?.id && userId === client.user.id) return true;
    return false;
  }

  function handleVoiceStateUpdate(oldState, newState) {
    const userId = newState?.id ?? oldState?.id;
    if (!userId) return;

    const member = newState?.member ?? oldState?.member;
    if (isIgnoredUser(userId, member)) return;

    const wasInChannel = oldState?.channelId === channelId;
    const isInChannel = newState?.channelId === channelId;

    if (!wasInChannel && isInChannel) {
      members.set(userId, {
        userId,
        username: displayNameOf(member?.user, 'Quelqu’un'),
        activity: declaredActivities.get(userId) ?? null,
        joinedAt: now(),
      });
      console.log(
        `[VoiceActivity] ${members.get(userId).username} a rejoint le salon suivi (${members.size} humain(s)).`
      );
    } else if (wasInChannel && !isInChannel) {
      const left = members.get(userId);
      members.delete(userId);
      console.log(
        `[VoiceActivity] ${left?.username ?? userId} a quitté le salon suivi (${members.size} humain(s)).`
      );
    } else if (wasInChannel && isInChannel) {
      const entry = members.get(userId);
      if (entry) {
        entry.username = displayNameOf(member?.user, entry.username);
        entry.activity = declaredActivities.get(userId) ?? null;
      } else {
        members.set(userId, {
          userId,
          username: displayNameOf(member?.user, 'Quelqu’un'),
          activity: declaredActivities.get(userId) ?? null,
          joinedAt: null,
        });
      }
    } else {
      return;
    }

    return applyStatus();
  }

  function syncFromVoiceStates() {
    members.clear();
    let channelFound = false;
    for (const guild of client.guilds.cache.values()) {
      const channel = guild.channels?.cache?.get(channelId);
      if (!channel?.members) continue;
      channelFound = true;

      for (const guildMember of channel.members.values()) {
        if (isIgnoredUser(guildMember.id, guildMember)) continue;
        members.set(guildMember.id, {
          userId: guildMember.id,
          username: displayNameOf(guildMember.user, 'Quelqu’un'),
          activity: declaredActivities.get(guildMember.id) ?? null,
          joinedAt: null,
        });
      }
    }

    if (!channelFound) {
      console.warn(
        `[VoiceActivity] Trigger voice channel ${channelId} was not found in the guild cache. Check bot access and the GuildVoiceStates intent.`
      );
    } else {
      console.log(
        `[VoiceActivity] Membership rebuilt: ${members.size} human(s) in channel ${channelId}.`
      );
    }
  }

  async function handleInteraction(interaction) {
    if (!interaction.isChatInputCommand?.()) return false;
    if (interaction.commandName !== 'activity') return false;

    const userId = interaction.user.id;
    const allowed = await hasGuildPermission({
      client,
      guildId: interaction.guildId,
      userId,
      allowedRoleIds: [ACTIVITY_ROLE_ID],
      includeAdmin: true,
      ignoreNativePermissions: true,
    });

    if (!allowed) {
      await interaction.reply(
        createV2EphemeralError(
          "Tu n'as pas le rôle requis pour déclarer une activité.",
          'Permission insuffisante'
        )
      );
      return true;
    }

    const choice = interaction.options.getString('statut', true);

    if (choice === 'stop') {
      declaredActivities.delete(userId);
    } else {
      declaredActivities.set(userId, choice);
    }

    const entry = members.get(userId);
    if (entry) {
      entry.activity = choice === 'stop' ? null : choice;
    }

    await applyStatus();

    const responses = {
      [ACTIVITY_AURAFARM]:
        "Ton activité **Aurafarm** sera reflétée sur le statut du bot dès que tu rejoins le salon vocal suivi.",
      [ACTIVITY_DEVELOPMENT]:
        "Ton activité **Développement** sera reflétée sur le statut du bot dès que tu rejoins le salon vocal suivi.",
      stop: "Ton activité n'est plus reflétée sur le statut du bot.",
    };

    await interaction.reply(
      createV2Message({
        title: 'Activité mise à jour',
        description: responses[choice] ?? responses.stop,
        ephemeral: true,
      })
    );

    return true;
  }

  function scheduleReconnectSync() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      try {
        syncFromVoiceStates();
        invalidateCache();
        void applyStatus();
      } catch (error) {
        console.error(
          '[VoiceActivity] Resync after reconnect failed:',
          error?.message ?? error
        );
      }
    }, reconnectDelayMs);
  }

  function start() {
    console.log(`[VoiceActivity] Listening to voiceStateUpdate on channel ${channelId}.`);

    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      try {
        void handleVoiceStateUpdate(oldState, newState);
      } catch (error) {
        console.error(
          '[VoiceActivity] voiceStateUpdate handling failed:',
          error?.message ?? error
        );
      }
    });

    client.on(Events.ShardReady, scheduleReconnectSync);
    client.on(Events.ShardResume, scheduleReconnectSync);

    if (refreshMs > 0) {
      refreshTimer = setInterval(() => {
        void applyStatus();
      }, refreshMs);
      refreshTimer.unref?.();
    }
  }

  function stop() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  return {
    channelId,
    members,
    declaredActivities,
    start,
    stop,
    syncFromVoiceStates,
    handleVoiceStateUpdate,
    handleInteraction,
    applyStatus,
  };
}
