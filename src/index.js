import 'dotenv/config';
import {
  ActionRowBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import { createPrivateKey, randomUUID } from 'node:crypto';

const GUILD_ID = '1454217001626243288';
const LOG_CHANNEL_ID = '1472309654729261287';
const BLOODLINE_CHANNEL_ID = '1472283879695192179';
const AUTHORIZED_ROLE_ID = '1535269258701963284';
const TIMEZONE_INPUT_ID = 'timezone';
const BLOODLINE_MAX_MEMBERS = 15;
const BLOODLINE_CONTACT_TEXT = 'Contactez ui3349';
const pendingBloodlineAdds = new Map();

const commands = [
  new SlashCommandBuilder()
    .setName('bloodline-add')
    .setDescription('Ajoute un membre à la bloodline.'),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Mesure le temps de réponse du bot.'),
];

for (const key of ['DISCORD_TOKEN', 'DISCORD_APPLICATION_ID', 'GOOGLE_SHEET_ID']) {
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

function hasAuthorizedRole(member) {
  if (!member) return false;
  if (Array.isArray(member.roles)) return member.roles.includes(AUTHORIZED_ROLE_ID);
  return member.roles.cache.has(AUTHORIZED_ROLE_ID);
}

function parseServiceAccountJson(value) {
  const firstParse = JSON.parse(value);
  return typeof firstParse === 'string' ? JSON.parse(firstParse) : firstParse;
}

function normalizePrivateKey(privateKey) {
  return privateKey
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\\+r\\+n/g, '\n')
    .replace(/\\+n/g, '\n')
    .replace(/\r\n/g, '\n')
    .concat('\n');
}

function getSheetsClient() {
  const fileVariable = process.env.GOOGLE_SERVICE_ACCOUNT_FILE?.trim();
  const jsonFromEnvironment = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    || ((fileVariable?.startsWith('{') || fileVariable?.startsWith('"'))
      ? fileVariable
      : undefined);

  let credentials;
  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      credentials = {
        type: 'service_account',
        project_id: process.env.GOOGLE_SERVICE_ACCOUNT_PROJECT_ID,
        client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      };
    } else {
      credentials = jsonFromEnvironment
        ? parseServiceAccountJson(jsonFromEnvironment)
        : parseServiceAccountJson(readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
    }

    credentials.private_key = normalizePrivateKey(credentials.private_key);
    createPrivateKey(credentials.private_key);
  } catch {
    throw new Error(
      'Google credentials are invalid. On Railway, use GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.',
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_APPLICATION_ID, GUILD_ID),
    { body: commands.map((command) => command.toJSON()) },
  );
}

async function findNextSheetRow(sheets, sheetTab) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${sheetTab}!A:G`,
  });
  const rows = response.data.values ?? [];
  let lastUsedRow = 1;

  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].some((value) => String(value).trim() !== '')) lastUsedRow = index + 1;
  }

  return Math.max(2, lastUsedRow + 1);
}

async function addBloodlineMember(pendingAdd, timezone) {
  const sheets = getSheetsClient();
  const sheetTab = process.env.GOOGLE_SHEET_TAB || 'Sheet1';
  const row = await findNextSheetRow(sheets, sheetTab);
  const joinedAt = String(Date.now());

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${sheetTab}!C${row}:G${row}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[pendingAdd.targetDisplayName, pendingAdd.targetUsername, pendingAdd.targetId, timezone, joinedAt]],
    },
  });
}

async function getBloodlineEntries() {
  const sheets = getSheetsClient();
  const sheetTab = process.env.GOOGLE_SHEET_TAB || 'Sheet1';
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: `${sheetTab}!C:G`,
  });

  const rows = response.data.values ?? [];
  const entries = [];
  const seenIds = new Set();

  for (const row of rows) {
    if (!row || row.every((value) => String(value).trim() === '')) continue;

    const [displayName, username, id, timezone, joinedAt] = row;
    const normalizedId = String(id ?? '').trim();
    if (!normalizedId || seenIds.has(normalizedId)) continue;

    seenIds.add(normalizedId);
    entries.push({
      id: normalizedId,
      displayName: String(displayName ?? '').trim() || String(username ?? '').trim() || normalizedId,
      username: String(username ?? '').trim(),
      timezone: String(timezone ?? '').trim(),
      joinedAt: joinedAt ? Number(joinedAt) : null,
    });
  }

  return entries.sort((left, right) => Number(left.joinedAt ?? 0) - Number(right.joinedAt ?? 0));
}

function buildBloodlineDescription(entries) {
  const visibleEntries = entries.slice(0, BLOODLINE_MAX_MEMBERS);
  if (!visibleEntries.length) {
    return 'Aucun membre pour le moment.';
  }

  return visibleEntries
    .map((entry, index) => {
      const timestamp = entry.joinedAt ? Math.floor(entry.joinedAt / 1000) : Math.floor(Date.now() / 1000);
      return `${index + 1}. <@${entry.id}> - Membre depuis <t:${timestamp}:F>`;
    })
    .join('\n');
}

async function syncBloodlineEmbed() {
  const entries = await getBloodlineEntries();
  const channel = await client.channels.fetch(BLOODLINE_CHANNEL_ID);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    throw new Error(`The bloodline channel ${BLOODLINE_CHANNEL_ID} is unavailable or the bot cannot send messages there.`);
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('Bloodline')
    .setDescription(buildBloodlineDescription(entries))
    .setFooter({ text: `${entries.length}/${BLOODLINE_MAX_MEMBERS} membres` })
    .setTimestamp(Date.now());

  const messages = await channel.messages.fetch({ limit: 50 });
  const existingMessage = [...messages.values()].find((message) => message.embeds.some((item) => item.title === 'Bloodline'));

  if (existingMessage) {
    await existingMessage.edit({ embeds: [embed], allowedMentions: { parse: [] } });
  } else {
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  }
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

  if (interaction.isChatInputCommand() && interaction.commandName === 'bloodline-add') {
    if (!hasAuthorizedRole(interaction.member)) {
      await interaction.reply({ content: 'Tu n’as pas le rôle nécessaire pour utiliser cette commande.', ephemeral: true });
      return;
    }

    const memberSelect = new UserSelectMenuBuilder()
      .setCustomId(`bloodline-add:select:${interaction.user.id}`)
      .setPlaceholder('Sélectionne le membre à ajouter')
      .setMinValues(1)
      .setMaxValues(1);
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription('Qui veux-tu ajouter à la bloodline ?');

    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(memberSelect)],
      ephemeral: true,
    });
    return;
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'ping') {
    const sentAt = Date.now();
    await interaction.reply({ content: 'Pong...', ephemeral: true });
    await interaction.editReply(`Pong ! Temps de réponse: ${Date.now() - sentAt} ms`);
    return;
  }

  if (interaction.isUserSelectMenu() && interaction.customId.startsWith('bloodline-add:select:')) {
    const [, , requestingUserId] = interaction.customId.split(':');
    if (interaction.user.id !== requestingUserId || !hasAuthorizedRole(interaction.member)) {
      await interaction.reply({ content: 'Cette demande ne t’appartient pas.', ephemeral: true });
      return;
    }

    const targetId = interaction.values[0];
    const targetUser = interaction.users.get(targetId);
    const targetMember = interaction.members.get(targetId);
    if (!targetUser) {
      await interaction.reply({ content: 'Membre introuvable. Réessaie.', ephemeral: true });
      return;
    }

    const requestId = randomUUID();
    pendingBloodlineAdds.set(requestId, {
      requestingUserId,
      targetId,
      targetUsername: targetUser.username,
      targetDisplayName: targetMember?.nick ?? targetUser.globalName ?? targetUser.username,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });

    const modal = new ModalBuilder()
      .setCustomId(`bloodline-add:timezone:${requestId}`)
      .setTitle('Bloodline — timezone');
    const timezoneInput = new TextInputBuilder()
      .setCustomId(TIMEZONE_INPUT_ID)
      .setLabel('Timezone')
      .setPlaceholder('Ex. Europe/Paris')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);
    modal.addComponents(new ActionRowBuilder().addComponents(timezoneInput));
    await interaction.showModal(modal);
    return;
  }

  if (!interaction.isModalSubmit() || !interaction.customId.startsWith('bloodline-add:timezone:')) return;

  const requestId = interaction.customId.replace('bloodline-add:timezone:', '');
  const pendingAdd = pendingBloodlineAdds.get(requestId);
  pendingBloodlineAdds.delete(requestId);
  if (!pendingAdd || pendingAdd.expiresAt < Date.now() || interaction.user.id !== pendingAdd.requestingUserId || !hasAuthorizedRole(interaction.member)) {
    await interaction.reply({ content: 'Cette demande ne t’appartient pas.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  try {
    const timezone = interaction.fields.getTextInputValue(TIMEZONE_INPUT_ID).trim();
    const existingEntries = await getBloodlineEntries();
    if (existingEntries.some((entry) => entry.id === pendingAdd.targetId)) {
      await interaction.editReply('Ce membre est déjà dans la bloodline.');
      return;
    }

    if (existingEntries.length >= BLOODLINE_MAX_MEMBERS) {
      await interaction.editReply(BLOODLINE_CONTACT_TEXT);
      return;
    }

    await addBloodlineMember(pendingAdd, timezone);
    await syncBloodlineEmbed();

    const timestamp = Math.floor(Date.now() / 1000);
    const embed = new EmbedBuilder()
      .setTitle('Membre ajouté à la bloodline')
      .setDescription(
        `<@${pendingAdd.targetId}> a bien été ajouté à la bloodline et sur le Google Sheet\n\n-# <t:${timestamp}:F> - French Squadron Utilities`,
      );
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Unable to add bloodline member:', error);
    await interaction.editReply('Impossible d’ajouter le membre au Google Sheet. Vérifie la configuration Google du bot.');
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Connected as ${readyClient.user.tag}`);
  void registerCommands()
    .then(() => console.log(`Commands registered for guild ${GUILD_ID}`))
    .catch((error) => console.error('Unable to register commands (the bot remains online):', error));
  void syncBloodlineEmbed()
    .catch((error) => console.error('Unable to sync bloodline embed:', error));
});

client.on(Events.InteractionCreate, (interaction) => {
  void handleInteraction(interaction).catch((error) => console.error('Unable to handle interaction:', error));
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