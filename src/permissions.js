import { PermissionFlagsBits } from 'discord.js';

export const PMODERATION_ROLE_ID = '1487266203864006707';
export const SUPER_ADMIN_ROLE_ID = '1518410191933014057';

export function hasDiscordAdministrator(member) {
  return Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));
}

export function hasRole(member, roleId) {
  return Boolean(member?.roles?.cache?.has(roleId));
}

export function hasSuperAdminAccess(member) {
  return hasDiscordAdministrator(member) || hasRole(member, SUPER_ADMIN_ROLE_ID);
}

export function hasAnyRole(member, roleIds = []) {
  return roleIds.some((roleId) => hasRole(member, roleId));
}

export async function hasGuildPermission({
  client,
  guildId,
  userId,
  requiredPermission = null,
  allowedRoleIds = [],
  includeAdmin = true,
  ignoreNativePermissions = false,
}) {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return false;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;

  if (includeAdmin && hasDiscordAdministrator(member)) return true;
  if (hasAnyRole(member, allowedRoleIds)) return true;
  if (ignoreNativePermissions) return false;
  if (requiredPermission && member.permissions?.has(requiredPermission)) return true;

  return false;
}
