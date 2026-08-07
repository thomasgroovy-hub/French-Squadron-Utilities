import 'dotenv/config';
import {
  ActionRowBuilder,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import { readFileSync } from 'node:fs';
import { google } from 'googleapis';
import { randomUUID } from 'node:crypto';

const GUILD_ID = '1454217001626243288';
const AUTHORIZED_ROLE_ID = '1535269258701963284';
const TIMEZONE_INPUT_ID = 'timezone';
const pendingBloodlineAdds = new Map();

const requiredConfiguration = [
  'DISCORD_TOKEN',
  'DISCORD_APPLICATION_ID',
  'GOOGLE_SHEET_ID',
];

for (const key of requiredConfiguration) {
  if (!process.env[key]) {
    throw new Error(`${key} is required. Add it to .env or your host's environment variables.`);
  }
}

if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
  throw new Error('GOOGLE_SERVICE_ACCOUNT_FILE or GOOGLE_SERVICE_ACCOUNT_JSON is required.');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const command = new SlashCommandBuilder()
  .setName('bloodline-add')
  .setDescription('Ajoute un membre à la bloodline.');

function hasAuthorizedRole(member) {
  if (!member) return false;

  if (Array.isArray(member.roles)) {
    return member.roles.includes(AUTHORIZED_ROLE_ID);
  }

  return member.roles.cache.has(AUTHORIZED_ROLE_ID);
}

function getSheetsClient() {
  let credentials;

  try {
    const credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_FILE
      ? readFileSync(process.env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8')
      : process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    credentials = JSON.parse(credentialsJson);
  } catch {
    throw new Error('The configured Google service-account credentials are not valid JSON.');
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return google.sheets({ version: 'v4', auth });
}

async function registerCommand() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(process.env.DISCORD_APPLICATION_ID, GUILD_ID),
    { body: [command.toJSON()] },
  );
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Connected as ${readyClient.user.tag}`);
});

async function handleInteraction(interaction) {
  if (interaction.guildId !== GUILD_ID) return;

  if (interaction.isChatInputCommand() && interaction.commandName === 'bloodline-add') {
    if (!hasAuthorizedRole(interaction.member)) {
      await interaction.reply({
        content: 'Tu n’as pas le rôle nécessaire pour utiliser cette commande.',
        ephemeral: true,
      });
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

  if (
    !pendingAdd
    || pendingAdd.expiresAt < Date.now()
    || interaction.user.id !== pendingAdd.requestingUserId
    || !hasAuthorizedRole(interaction.member)
  ) {
    await interaction.reply({ content: 'Cette demande ne t’appartient pas.', ephemeral: true });
    return;
  }

  await interaction.deferReply();

  try {
    const timezone = interaction.fields.getTextInputValue(TIMEZONE_INPUT_ID).trim();
    const sheets = getSheetsClient();
    const sheetTab = process.env.GOOGLE_SHEET_TAB || 'Sheet1';

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${sheetTab}!C:F`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[pendingAdd.targetDisplayName, pendingAdd.targetUsername, pendingAdd.targetId, timezone]],
      },
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const embed = new EmbedBuilder()
      .setTitle('Membre ajouté à la bloodline')
      .setDescription(
        `<@${pendingAdd.targetId}> a bien été ajouté à la bloodline et sur le Google Sheet\n\n-# <t:${timestamp}:F> - French Squadron Utilities`,
      );

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('Unable to add bloodline member:', error);
    await interaction.editReply('Impossible d’ajouter le membre au Google Sheet. Vérifie la configuration du bot.');
  }
}

client.on(Events.InteractionCreate, (interaction) => {
  void handleInteraction(interaction).catch((error) => {
    console.error('Unable to handle interaction:', error);
  });
});

await registerCommand();
await client.login(process.env.DISCORD_TOKEN);
