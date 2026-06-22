import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import { config } from './config';
import { slackRouter, rawBodySaver } from './routes/slack';
import { apiRouter } from './routes/api';
import { startWorker, stopWorker } from './queues/worker';
import { pool } from './db';

const app = express();

// Apply security headers (customizing content security policy to allow frontend resources)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https://a.slack-edge.com"],
        connectSrc: ["'self'"]
      }
    }
  })
);

// Enable CORS
app.use(cors());

// Parse JSON and urlencoded request bodies, capturing raw buffer for Slack signature verification
app.use(express.json({ verify: rawBodySaver }));
app.use(express.urlencoded({ verify: rawBodySaver, extended: true }));

// Serve frontend assets
app.use(express.static(path.join(__dirname, '../public')));

// Mount routes
app.use('/slack', slackRouter);
app.use('/api', apiRouter);

// Fallback: Send static index.html for UI SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start the server
const server = app.listen(config.port, () => {
  console.log(`===============================================`);
  console.log(` Recall Decision Memory Server Running Locally  `);
  console.log(` Port: ${config.port} | Mode: ${config.nodeEnv} `);
  console.log(`===============================================`);
  
  // Start background worker to process message queue
  startWorker();
});

// Graceful Shutdown
async function handleShutdown(signal: string) {
  console.log(`\nReceived ${signal}. Starting graceful shutdown...`);
  
  // Stop receiving incoming requests
  server.close(() => {
    console.log('HTTP server closed.');
  });

  // Stop BullMQ worker
  await stopWorker();

  // Close database pool connection
  await pool.end();
  console.log('Database pool connection closed.');
  
  console.log('Graceful shutdown complete. Exiting.');
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
