import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const indexSource = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const moderationSource = await readFile(new URL('../src/moderation.js', import.meta.url), 'utf8');

test('slash commands use global registration', () => {
  assert.match(indexSource, /Routes\.applicationCommands\(process\.env\.DISCORD_APPLICATION_ID\)/);
  assert.doesNotMatch(indexSource, /Routes\.applicationGuildCommands/);
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
