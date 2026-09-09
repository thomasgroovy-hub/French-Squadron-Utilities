import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';

import {
  createModerationIntegration,
  moderationCommands,
} from './moderation.js';

import {
  createRobloxIntegration,
  robloxCommands,
} from './roblox.js';

import {
  createV2EphemeralError,
  createV2Message,
} from './components.js';

const GUILD_ID = '1454217001626243288';

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Mesure le temps de réponse du bot.'),

  ...robloxCommands,
  ...moderationCommands,
];

// Vérification des variables d'environnement
for (const key of ['DISCORD_TOKEN', 'DISCORD_APPLICATION_ID']) {
  if (!process.env[key]) {
    throw new Error(
      `${key} is required. Add it to .env or Railway variables.`
    );
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const robloxIntegration = createRobloxIntegration({
  client,
  guildId: GUILD_ID,
});

const moderationIntegration = createModerationIntegration({
  client,
});

/** Enregistre les commandes dans une guilde précise. */
async function registerCommandsForGuild(rest, guildId, body) {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_APPLICATION_ID,
      guildId,
    ),
    { body },
  );
}

/**
 * Synchronise immédiatement toutes les guildes connues et les nouvelles
 * guildes rejointes, sans conserver de commandes globales en doublon.
 */
async function registerCommands() {
  const rest = new REST({ version: '10' })
    .setToken(process.env.DISCORD_TOKEN);

  const body = commands.map((command) => command.toJSON());

  console.log('========================================');
  console.log('[Discord] Command registration diagnostic');
  console.log('========================================');

  console.log(
    '[Discord] Config Application ID:',
    process.env.DISCORD_APPLICATION_ID
  );

  console.log(
    '[Discord] Logged-in Application ID:',
    client.application?.id
  );

  console.log(
    '[Discord] Bot User ID:',
    client.user?.id
  );

  console.log(
    '[Discord] Bot Username:',
    client.user?.tag
  );

  console.log('========================================');

  try {
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_APPLICATION_ID),
      { body: [] },
    );
    console.log('[Discord] Stale global commands removed.');
  } catch (error) {
    console.error('[Discord] Unable to remove stale global commands.');
    console.error('Status:', error?.status);
    console.error('Discord Code:', error?.code);
    console.error('Message:', error?.message);
    if (error?.rawError) {
      console.error('Raw Discord Error:', error.rawError);
    }
  }

  for (const guild of client.guilds.cache.values()) {
    try {
      await registerCommandsForGuild(rest, guild.id, body);
      console.log(`[Discord] ${body.length} commands registered for ${guild.name} (${guild.id}).`);
    } catch (error) {
      console.error(`[Discord] Command registration failed for ${guild.name} (${guild.id}).`, error.message);
    }
  }

  console.log('========================================');
  console.log('[Discord] Command registration test finished');
  console.log('========================================');
}

client.on(Events.GuildCreate, (guild) => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const body = commands.map((command) => command.toJSON());
  void registerCommandsForGuild(rest, guild.id, body)
    .then(() => {
      console.log(`[Discord] Commands registered for new guild ${guild.name} (${guild.id}).`);
    })
    .catch((error) => {
      console.error(`[Discord] Command registration failed for new guild ${guild.name} (${guild.id}).`, error.message);
    });
});

async function handleInteraction(interaction) {
  if (
    interaction.isChatInputCommand() &&
    interaction.commandName === 'ping'
  ) {
    const start = Date.now();

    await interaction.deferReply({
      ephemeral: true,
    });

    const roundTrip = Date.now() - start;

    const wsPing =
      client.ws.ping >= 0
        ? `${client.ws.ping}ms`
        : '—';

    let robloxPing = '—';

    try {
      const robloxStart = Date.now();

      await fetch(
        'https://users.roblox.com/v1/usernames/users',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            usernames: ['Roblox'],
            excludeBannedUsers: false,
          }),
          signal: AbortSignal.timeout(2500),
        }
      );

      robloxPing = `${Date.now() - robloxStart}ms`;
    } catch {
      robloxPing = 'Hors ligne';
    }

    await interaction.editReply(
      createV2Message({
        title: 'Pong !',
        description:
          `Temps de réponse : **${roundTrip}ms**`,
        sections: [
          `**API Discord :** ${wsPing}\n` +
          `**API Roblox :** ${robloxPing}`,
        ],
      })
    );

    return;
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Connected as ${readyClient.user.tag}`);

  console.log(
    `[Discord] Logged in with User ID: ${readyClient.user.id}`
  );

  console.log(
    `[Discord] Application ID: ${readyClient.application.id}`
  );

  void robloxIntegration.initializeDatabase();

  void registerCommands()
    .then(() => {
      console.log('[Discord] Command registration process completed.');
    })
    .catch((error) => {
      console.error(
        'Unable to register commands (the bot remains online):',
        error
      );
    });

  void moderationIntegration.initializeDatabase();
});

client.on(Events.InteractionCreate, (interaction) => {
  void (async () => {
    console.log('[Discord] Interaction received:', {
      type: interaction.type,
      commandName: interaction.isChatInputCommand() ? interaction.commandName : null,
      customId: interaction.isButton() ? interaction.customId : null,
      guildId: interaction.guildId,
      user: interaction.user ? `${interaction.user.tag} (${interaction.user.id})` : null,
    });

    if (
      await robloxIntegration.handleInteraction(interaction)
    ) {
      console.log('[Discord] Interaction handled by Roblox integration.');
      return;
    }

    if (
      await moderationIntegration.handleInteraction(interaction)
    ) {
      console.log('[Discord] Interaction handled by moderation integration.');
      return;
    }

    console.log('[Discord] Interaction was not handled by a command integration.');
    await handleInteraction(interaction);
  })().catch(async (error) => {
    console.error(
      'Unable to handle interaction:',
      error
    );

    if (!interaction.isRepliable()) {
      return;
    }

    const payload = createV2EphemeralError(
      'Une erreur inattendue est survenue. Réessaie plus tard.',
      'Erreur'
    );

    try {
      if (
        interaction.deferred ||
        interaction.replied
      ) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch (replyError) {
      console.error(
        'Unable to publish interaction error:',
        replyError.message
      );
    }
  });
});

client.on(
  Events.Error,
  (error) => {
    console.error(
      'Discord client error:',
      error
    );
  }
);

robloxIntegration.startHttpServer();

process.on(
  'unhandledRejection',
  (error) => {
    console.error(
      'Unhandled rejection:',
      error
    );
  }
);

async function shutdown(signal) {
  console.log(
    `[Bot] ${signal} received. Stopping services...`
  );

  try {
    await robloxIntegration.stopHttpServer();
  } catch (error) {
    console.error(
      '[Roblox] Error closing HTTP server:',
      error.message
    );
  }

  client.destroy();

  process.exit(0);
}

process.on(
  'SIGINT',
  () => void shutdown('SIGINT')
);

process.on(
  'SIGTERM',
  () => void shutdown('SIGTERM')
);

await client.login(
  process.env.DISCORD_TOKEN
);