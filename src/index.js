import 'dotenv/config';
import {
  ActionRowBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { createModerationIntegration, moderationCommands } from './moderation.js';
import { createRobloxIntegration, robloxCommands } from './roblox.js';

const GUILD_ID = '1454217001626243288';
const MODERATION_GUILD_ID = '1487258655840669807';
const LOG_CHANNEL_ID = '1546193398388494336';

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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
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

function transcriptFor(message) {
  const attachments = [...message.attachments.values()]
    .map((attachment) => `${attachment.name ?? 'Pièce jointe'}: ${attachment.url}`);
  const stickers = [...message.stickers.values()]
    .map((sticker) => sticker.name);
  const parts = [message.content || '(sans texte)'];

  if (attachments.length) parts.push(`Pièces jointes:\n${attachments.join('\n')}`);
  if (stickers.length) parts.push(`Stickers: ${stickers.join(', ')}`);
  return parts.join('\n\n');
}

// Wraps text in a fenced code block, truncating so a single embed field
// (1024 char limit) never overflows even with long messages/attachments.
function codeBlock(text, maxLength = 950) {
  const safeText = text && text.length > 0 ? text : '(sans texte)';
  const truncated = safeText.length > maxLength
    ? `${safeText.slice(0, maxLength)}\n… (tronqué)`
    : safeText;
  return `\`\`\`\n${truncated}\n\`\`\``;
}

async function sendTranscriptLog(kind, message, previousContent) {
  if (!message.inGuild() || message.guildId !== GUILD_ID || message.channelId === LOG_CHANNEL_ID || message.author?.bot) return;

  const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
  if (!logChannel?.isTextBased() || !logChannel.isSendable()) {
    throw new Error(`The log channel ${LOG_CHANNEL_ID} is unavailable or the bot cannot send messages there.`);
  }

  const author = message.author;
  const timestamp = Math.floor(message.createdTimestamp / 1000);
  const content = transcriptFor(message);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setAuthor({
      name: author?.tag ?? 'Inconnu',
      iconURL: author?.displayAvatarURL?.(),
    })
    .setTitle(kind)
    .setDescription(`[Aller au message](${message.url})`)
    .setFooter({ text: 'French Squadron Utilities' })
    .setTimestamp(message.createdTimestamp);

  const metadataFields = [
    { name: 'Auteur', value: `${author?.tag ?? 'Inconnu'} (${author?.id ?? '—'})`, inline: true },
    { name: 'Salon source', value: `<#${message.channelId}>`, inline: true },
    { name: 'Message ID', value: message.id ?? '—', inline: true },
    { name: 'Date', value: `<t:${timestamp}:F>`, inline: true },
  ];

  if (previousContent !== undefined) {
    embed.addFields(...metadataFields);
    embed.addFields(
      { name: 'Avant', value: codeBlock(previousContent), inline: false },
      { name: 'Après', value: codeBlock(content), inline: false },
    );
  } else {
    embed.addFields(...metadataFields);
    embed.addFields({ name: 'Contenu', value: codeBlock(content), inline: false });
  }

  await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleInteraction(interaction) {
  if (interaction.guildId !== GUILD_ID) return;

  if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
    const sentAt = Date.now();
    await interaction.reply({ content: 'Pong...', ephemeral: true });
    await interaction.editReply(`Pong ! Temps de réponse: ${Date.now() - sentAt} ms`);
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

client.on(Events.MessageCreate, (message) => {
  void sendTranscriptLog('Message envoyé', message).catch((error) => console.error('Unable to log a message:', error));
});

client.on(Events.MessageUpdate, (oldMessage, newMessage) => {
  void (async () => {
    const resolvedMessage = newMessage.partial ? await newMessage.fetch() : newMessage;
    await sendTranscriptLog('Message modifié', resolvedMessage, oldMessage.partial ? undefined : oldMessage.content);
  })().catch((error) => console.error('Unable to log a message update:', error));
});

client.on(Events.Error, (error) => console.error('Discord client error:', error));
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

await client.login(process.env.DISCORD_TOKEN);
