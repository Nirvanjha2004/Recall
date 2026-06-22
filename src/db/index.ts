import { Pool, PoolConfig, QueryResultRow } from 'pg';
import { config } from '../config';

const poolConfig: PoolConfig = config.db.connectionString
  ? { connectionString: config.db.connectionString }
  : {
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
    };

export const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
});

export const db = {
  /**
   * Run a query on the database pool.
   */
  async query<T extends QueryResultRow = any>(text: string, params?: any[]) {
    const start = Date.now();
    try {
      const res = await pool.query<T>(text, params);
      const duration = Date.now() - start;
      if (config.nodeEnv === 'development') {
        console.log('Executed query', { text, duration, rowsCount: res.rowCount });
      }
      return res;
    } catch (error) {
      console.error('Database query error', { text, error });
      throw error;
    }
  },

  /**
   * Get a client from the pool for transactions.
   */
  async getClient() {
    const client = await pool.connect();
    return client;
  }
};
