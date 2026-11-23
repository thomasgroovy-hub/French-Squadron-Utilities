import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexSource = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const moderationSource = await readFile(new URL('../src/moderation.js', import.meta.url), 'utf8');
const verificationSource = await readFile(new URL('../src/roblox-verification.js', import.meta.url), 'utf8');

test('slash commands synchronize every guild and new guilds', () => {
  assert.match(indexSource, /Routes\.applicationGuildCommands/);
  assert.match(indexSource, /client\.guilds\.cache\.values\(\)/);
  assert.match(indexSource, /Events\.GuildCreate/);
  assert.match(indexSource, /Routes\.applicationCommands\(process\.env\.DISCORD_APPLICATION_ID\)/);
  assert.match(indexSource, /\{ body: \[\] \}/);
});

test('global ban and expulsion attempt the DM before moderation actions', () => {
  const banStart = moderationSource.indexOf('async function handleGlobalBan');
  const banEnd = moderationSource.indexOf('async function handleUntimeout');
  const banSource = moderationSource.slice(banStart, banEnd);
  assert.ok(banSource.indexOf('await target.send') < banSource.indexOf('await guild.members.ban'));

  const expulsionStart = moderationSource.indexOf('async function handleExpulsion');
  const expulsionEnd = moderationSource.indexOf('async function handleRemoveWarning');
  const expulsionSource = moderationSource.slice(expulsionStart, expulsionEnd);
  assert.ok(expulsionSource.indexOf('await target.send') < expulsionSource.indexOf('await member.kick'));
});

test('no-action responses exist for moderation cleanup commands', () => {
  assert.match(moderationSource, /Cet utilisateur n’est actuellement exclu sur aucun serveur\./);
  assert.match(moderationSource, /Cet utilisateur n’est actuellement banni sur aucun serveur\./);
  assert.match(moderationSource, /Cet utilisateur n’a actuellement aucun avertissement enregistré\./);
  assert.match(moderationSource, /guild\.bans\.fetch\(target\.id\)/);
});

test('who-is exposes a permission-checked moderation case file', () => {
  assert.match(verificationSource, /roblox_who_is_casefile:/);
  assert.match(verificationSource, /FROM strikes WHERE discord_id = \?/);
  assert.match(verificationSource, /FROM moderation_cases WHERE discord_id = \?/);
  assert.match(verificationSource, /FROM moderation_bans WHERE discord_id = \?/);
  assert.match(verificationSource, /Voir le casier de modération/);
  assert.match(verificationSource, /allowedRoleIds: \[UNLINK_ROLE_ID, MODERATION_ROLE_ID/);
});

test('warnings record the server where they were issued', () => {
  assert.match(moderationSource, /guild_id VARCHAR\(20\) NULL/);
  assert.match(moderationSource, /ADD COLUMN guild_id VARCHAR\(20\) NULL/);
  assert.match(moderationSource, /INSERT INTO \$\{STRIKE_TABLE\} \(discord_id, moderator_discord_id, raison, guild_id, guild_name\) VALUES \(\?, \?, \?, \?, \?\)/);
  assert.match(moderationSource, /interaction\.guild\?\.name/);
  assert.match(moderationSource, /logField\('Serveur'/);
});

test('every moderation case records the server where it was issued', () => {
  assert.match(moderationSource, /moderation_cases_guild_id_idx/);
  assert.match(moderationSource, /INSERT INTO \$\{CASE_TABLE\} \(discord_id, type, moderator_discord_id, raison, guild_id, guild_name\) VALUES \(\?, \?, \?, \?, \?, \?\)/);
  assert.match(moderationSource, /'exclusion', interaction, reason/);
  assert.match(moderationSource, /'bannissement', interaction, reason/);
  assert.match(moderationSource, /'expulsion', interaction, reason/);
});
