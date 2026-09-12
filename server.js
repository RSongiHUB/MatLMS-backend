import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';

import { pool, waitForDb } from './db.js';
import { runApplicationSeed } from './seed.js';

import authRoutes from './routes/auth.routes.js';
import courseRoutes from './routes/course.routes.js';
import progressRoutes from './routes/progress.routes.js';
import quizRoutes from './routes/quiz.routes.js';
import assignmentRoutes from './routes/assignment.routes.js';
import certificateRoutes from './routes/certificate.routes.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT) || 4000;

const app = express();

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false, // frontend uses the Tailwind CDN; tighten this once assets are self-hosted
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// -----------------------------------------------------------------------
// Health check — used by the Docker HEALTHCHECK and docker-compose
// -----------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unreachable', message: err.message });
  }
});

// -----------------------------------------------------------------------
// API routes
// -----------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/courses', courseRoutes);
app.use('/api/progress', progressRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/certificates', certificateRoutes);

app.get('/api', (req, res) => {
  res.json({
    name: 'Matrix LMS API',
    status: 'running',
    endpoints: [
      'POST /api/auth/register', 'POST /api/auth/login', 'GET /api/auth/me',
      'GET /api/courses', 'GET /api/courses/:id', 'POST /api/courses',
      'PUT /api/courses/:id', 'DELETE /api/courses/:id',
      'POST /api/courses/:id/enroll', 'GET /api/courses/me/enrolled',
      'POST /api/progress/lessons/:id/complete', 'GET /api/progress/courses/:id', 'GET /api/progress/me',
      'GET /api/quizzes/lesson/:id', 'POST /api/quizzes/:id/attempts', 'GET /api/quizzes/:id/attempts/me',
      'GET /api/assignments/lesson/:id', 'POST /api/assignments/:id/submissions',
      'GET /api/certificates/me', 'GET /api/certificates/:id', 'GET /api/certificates/verify/:code',
    ],
  });
});

// -----------------------------------------------------------------------
// Static frontend (bind-mounted into /app/public by docker-compose)
// -----------------------------------------------------------------------
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(publicDir, 'index.html'), (err) => {
    if (err) next(err);
  });
});

// -----------------------------------------------------------------------
// Error handler (last)
// -----------------------------------------------------------------------
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[error]', err);
  res.status(err.status || 500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// -----------------------------------------------------------------------
// Boot sequence: wait for the DB, run the app-level seed, then listen
// -----------------------------------------------------------------------
async function start() {
  await waitForDb();
  await runApplicationSeed();

  app.listen(PORT, () => {
    console.log(`[server] Matrix LMS backend listening on port ${PORT}`);
    console.log(`[server] environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

start().catch((err) => {
  console.error('[server] fatal error during startup', err);
  process.exit(1);
});
