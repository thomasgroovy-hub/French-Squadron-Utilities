import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';

import {
  MODERATION_ROLE_ID,
  ROBLOX_LOOKUP_ROLE_ID,
  SUPER_ADMIN_ROLE_ID,
  hasGuildPermission,
  hasRole,
  hasSuperAdminAccess,
} from '../src/permissions.js';

test('role ids are valid and clean', () => {
  assert.equal(MODERATION_ROLE_ID, '1487266203864006707');
  assert.equal(SUPER_ADMIN_ROLE_ID, '1518410191933014057');
  assert.equal(ROBLOX_LOOKUP_ROLE_ID, '1545975254277558282');
});

test('moderation role is allowed for unlink access', async () => {
  const fakeMember = {
    permissions: { has: () => false },
    roles: {
      cache: {
        has: (roleId) => roleId === MODERATION_ROLE_ID,
      },
    },
  };
  const fakeClient = {
    guilds: {
      cache: new Map([[
        '1487258655840669807',
        { members: { fetch: async () => fakeMember } },
      ]]),
    },
  };

  assert.equal(await hasGuildPermission({
    client: fakeClient,
    guildId: '1487258655840669807',
    userId: '123',
    allowedRoleIds: [MODERATION_ROLE_ID, ROBLOX_LOOKUP_ROLE_ID, SUPER_ADMIN_ROLE_ID],
    ignoreNativePermissions: true,
  }), true);
});

test('role-only moderation access works even without native Discord permissions', async () => {
  const fakeMember = {
    permissions: { has: () => false },
    roles: {
      cache: {
        has: (roleId) => roleId === MODERATION_ROLE_ID,
      },
    },
  };

  const fakeClient = {
    guilds: {
      cache: new Map([
        ['1487258655840669807', {
          members: {
            fetch: async () => fakeMember,
          },
        }],
      ]),
    },
  };

  const allowed = await hasGuildPermission({
    client: fakeClient,
    guildId: '1487258655840669807',
    userId: '123',
    allowedRoleIds: [MODERATION_ROLE_ID, SUPER_ADMIN_ROLE_ID],
    ignoreNativePermissions: true,
  });

  assert.equal(allowed, true);
});

test('admin access still works', async () => {
  const fakeMember = {
    permissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
    roles: { cache: { has: () => false } },
  };

  const fakeClient = {
    guilds: {
      cache: new Map([
        ['1487258655840669807', {
          members: {
            fetch: async () => fakeMember,
          },
        }],
      ]),
    },
  };

  const allowed = await hasGuildPermission({
    client: fakeClient,
    guildId: '1487258655840669807',
    userId: '123',
    allowedRoleIds: [MODERATION_ROLE_ID],
    ignoreNativePermissions: true,
  });

  assert.equal(allowed, true);
  assert.equal(hasSuperAdminAccess(fakeMember), true);
  assert.equal(hasRole(fakeMember, MODERATION_ROLE_ID), false);
});
