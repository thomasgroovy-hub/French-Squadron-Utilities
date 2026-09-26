import { PermissionFlagsBits } from 'discord.js';

export const MODERATION_ROLE_ID = '1487266203864006707';
export const SUPER_ADMIN_ROLE_ID = '1518410191933014057';
export const ROBLOX_LOOKUP_ROLE_ID = '1545975254277558282';

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
  console.log('[Permissions] Checking access:', {
    guildId,
    userId,
    allowedRoleIds,
    requiredPermission: requiredPermission?.toString() ?? null,
    includeAdmin,
    ignoreNativePermissions,
  });

  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    console.warn(`[Permissions] Guild ${guildId} is not in the client cache.`);
    return false;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    console.warn(`[Permissions] User ${userId} could not be fetched in guild ${guildId}.`);
    return false;
  }

  const roleCache = member.roles?.cache;
  const memberRoleIds = roleCache && typeof roleCache.keys === 'function'
    ? Array.from(roleCache.keys())
    : [];
  const matchingRoleIds = allowedRoleIds.filter((roleId) => hasRole(member, roleId));
  const administrator = hasDiscordAdministrator(member);
  console.log('[Permissions] Member data:', {
    guildId,
    userId,
    memberRoleIds,
    matchingRoleIds,
    administrator,
  });

  if (includeAdmin && administrator) {
    console.log(`[Permissions] Allowed user ${userId}: Administrator.`);
    return true;
  }
  if (matchingRoleIds.length) {
    console.log(`[Permissions] Allowed user ${userId}: matching role ${matchingRoleIds.join(', ')}.`);
    return true;
  }
  if (ignoreNativePermissions) {
    console.warn(`[Permissions] Denied user ${userId}: no matching allowed role.`);
    return false;
  }
  if (requiredPermission && member.permissions?.has(requiredPermission)) {
    console.log(`[Permissions] Allowed user ${userId}: native permission.`);
    return true;
  }

  console.warn(`[Permissions] Denied user ${userId}: no matching permission.`);
  return false;
}
