import mysql from 'mysql2/promise';

let poolInstance = null;

export function getDatabasePool() {
  if (poolInstance) return poolInstance;

  const required = ['MYSQL_HOST', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE'];
  if (required.some((name) => !process.env[name])) return null;

  poolInstance = mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number.parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 10_000,
  });

  return poolInstance;
}

export function createDatabasePool() {
  return getDatabasePool();
}

export async function closeDatabasePool() {
  if (poolInstance) {
    const pool = poolInstance;
    poolInstance = null;
    await pool.end();
  }
}