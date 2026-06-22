import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { db, pool } from './index';
import { config } from '../config';

async function bootstrapDatabase() {
  console.log('Checking if target database exists...');
  
  // Define connection options targeting the default 'postgres' database to boot up
  const connectionOptions = config.db.connectionString
    ? { connectionString: config.db.connectionString.replace(/\/[^/]+$/, '/postgres') }
    : {
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: 'postgres',
      };

  const client = new Client(connectionOptions);
  
  try {
    await client.connect();
    
    // Check if the 'recall' database already exists
    const res = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [config.db.database]);
    
    if (res.rowCount === 0) {
      console.log(`Database "${config.db.database}" does not exist. Creating it now...`);
      // CREATE DATABASE cannot be executed in parameterized queries in Postgres, so we escape safely
      await client.query(`CREATE DATABASE ${config.db.database}`);
      console.log(`✓ Database "${config.db.database}" successfully created.`);
    } else {
      console.log(`Database "${config.db.database}" already exists.`);
    }
  } catch (error) {
    console.error('Error during database bootstrapping:', error);
    throw error;
  } finally {
    await client.end();
  }
}

async function initDatabase() {
  try {
    // 1. Bootstrapping step
    await bootstrapDatabase();
    
    console.log('Initializing database schema...');
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');

    // 2. Run the migration schema
    await db.query(schemaSql);
    console.log('Database schema successfully applied!');
  } catch (error) {
    console.error('Failed to initialize database schema:', error);
    process.exit(1);
  } finally {
    await pool.end();
    console.log('Database connection pool closed.');
  }
}

if (require.main === module) {
  initDatabase();
}

export { initDatabase };
