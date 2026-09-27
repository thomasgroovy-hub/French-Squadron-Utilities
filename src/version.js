/**
 * Single source of truth for the running build. Printed as the first line of
 * every boot so a log always answers "which version is this?".
 *
 * Bump rules:
 *   - PATCH (V.01 -> V.02): bug fixes, wording, refactors with no behaviour change.
 *   - MINOR (V.01 -> V.11): a new feature, command, table or integration is added.
 *   - MAJOR (V.01 -> V.1.0): a breaking change, removed feature, or schema change
 *     that requires manual action on the host (env vars, migrations, uploads).
 */
export const BOT_VERSION = 'FPCSBOT V.01';

export function printVersionBanner(component = BOT_VERSION) {
  console.log('========================================');
  console.log(`  ${component}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log('========================================');
}
