import fs from 'node:fs';

const readEnv = (path) => {
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
};

const bot = readEnv(process.argv[2]);
for (const [key, value] of Object.entries({
  SITE_MYSQL_HOST: bot.MYSQL_HOST_SITE,
  SITE_MYSQL_PORT: '3306',
  SITE_MYSQL_USER: bot.MYSQL_USER_SITE,
  SITE_MYSQL_PASSWORD: bot.MYSQL_PASSWORD_SITE,
  SITE_MYSQL_DATABASE: bot.MYSQL_DATABASE_SITE,
})) {
  if (value) process.env[key] = value;
}

const mysql = (await import('mysql2/promise')).default;
const { reconcileRobloxMirror, closeRobloxMirrorPool } = await import('./src/roblox-mirror.js');

const botPool = mysql.createPool({
  host: bot.MYSQL_HOST,
  port: Number(bot.MYSQL_PORT || 3306),
  user: bot.MYSQL_USER,
  password: bot.MYSQL_PASSWORD,
  database: bot.MYSQL_DATABASE,
  connectTimeout: 10000,
});

try {
  console.log('reconcile ->', await reconcileRobloxMirror({ pool: botPool }));
} finally {
  await botPool.end();
  await closeRobloxMirrorPool?.();
  process.exit(0);
}
