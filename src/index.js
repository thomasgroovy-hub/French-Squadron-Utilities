import 'dotenv/config';
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { createModerationIntegration, moderationCommands } from './moderation.js';
import { createRobloxIntegration, robloxCommands } from './roblox.js';

const GUILD_ID = '1454217001626243288';
const MODERATION_GUILD_ID = '1487258655840669807';

const commands = [
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Mesure le temps de réponse du bot.'),
  ...robloxCommands,
  ...moderationCommands,
];

for (const key of ['DISCORD_TOKEN', 'DISCORD_APPLICATION_ID']) {
  if (!process.env[key]) {
    throw new Error(`${key} is required. Add it to .env or Railway variables.`);
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const robloxIntegration = createRobloxIntegration({ client, guildId: GUILD_ID });
const moderationIntegration = createModerationIntegration({ client });

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const body = commands.map((command) => command.toJSON());
  await Promise.all([
    rest.put(Routes.applicationGuildCommands(process.env.DISCORD_APPLICATION_ID, GUILD_ID), { body }),
    rest.put(Routes.applicationGuildCommands(process.env.DISCORD_APPLICATION_ID, MODERATION_GUILD_ID), { body }),
  ]);
}

async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
    const start = Date.now();
    await interaction.deferReply({ ephemeral: true });
    const roundTrip = Date.now() - start;
    const wsPing = client.ws.ping >= 0 ? `${client.ws.ping}ms` : '—';

    let robloxPing = '—';
    try {
      const robloxStart = Date.now();
      await fetch('https://users.roblox.com/v1/usernames/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames: ['Roblox'], excludeBannedUsers: false }),
        signal: AbortSignal.timeout(2500),
      });
      robloxPing = `${Date.now() - robloxStart}ms`;
    } catch {
      robloxPing = 'Hors ligne';
    }

    await interaction.editReply(`🏓Pong ! | Temps de réponse : ${roundTrip}ms | API : Discord ${wsPing}, Roblox ${robloxPing}`);
    return;
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Connected as ${readyClient.user.tag}`);
  void robloxIntegration.initializeDatabase();
  robloxIntegration.startHttpServer();
  void registerCommands()
    .then(() => console.log(`Commands registered for guild ${GUILD_ID}`))
    .catch((error) => console.error('Unable to register commands (the bot remains online):', error));
  void moderationIntegration.initializeDatabase();
});

client.on(Events.InteractionCreate, (interaction) => {
  void (async () => {
    if (await robloxIntegration.handleInteraction(interaction)) return;
    if (await moderationIntegration.handleInteraction(interaction)) return;
    await handleInteraction(interaction);
  })().catch((error) => console.error('Unable to handle interaction:', error));
});

client.on(Events.Error, (error) => console.error('Discord client error:', error));
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

async function shutdown(signal) {
  console.log(`[Bot] ${signal} received. Stopping services...`);
  try {
    await robloxIntegration.stopHttpServer();
  } catch (error) {
    console.error('[Roblox] Error closing HTTP server:', error.message);
  }
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await client.login(process.env.DISCORD_TOKEN);
