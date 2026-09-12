import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();
const SALT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,}$/; // 8+ chars, at least one letter and one digit

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, full_name: user.full_name },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' },
  );
}

function publicUser(row) {
  return { id: row.id, full_name: row.full_name, email: row.email, role: row.role, created_at: row.created_at };
}

/**
 * POST /api/auth/register
 * Public self-registration always creates a STUDENT account. Instructor
 * and admin accounts are provisioned ahead of time (see backend/src/seed.js
 * for the demo ones) rather than opened up through public registration —
 * appropriate for an internal onboarding LMS.
 */
router.post('/register', async (req, res) => {
  const { full_name, email, password } = req.body || {};

  if (!full_name || typeof full_name !== 'string' || full_name.trim().length < 2) {
    return res.status(400).json({ status: 'error', message: 'full_name must be at least 2 characters' });
  }
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ status: 'error', message: 'A valid email address is required' });
  }
  if (!password || !PASSWORD_RE.test(password)) {
    return res.status(400).json({
      status: 'error',
      message: 'Password must be at least 8 characters and include at least one letter and one number',
    });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ status: 'error', message: 'An account with that email already exists' });
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, 'student')
       RETURNING id, full_name, email, role, created_at`,
      [full_name.trim(), email.toLowerCase(), hash],
    );

    const user = result.rows[0];
    const token = signToken(user);
    return res.status(201).json({ status: 'ok', token, user: publicUser(user) });
  } catch (err) {
    console.error('[auth] register error', err);
    return res.status(500).json({ status: 'error', message: 'Could not create account' });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ status: 'error', message: 'Email and password are required' });
  }

  try {
    const result = await pool.query(
      'SELECT id, full_name, email, password_hash, role, is_active, created_at FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    const user = result.rows[0];

    // Deliberately identical error for "no such user" and "wrong password"
    // so login attempts can't be used to enumerate valid email addresses.
    if (!user || !user.is_active) {
      return res.status(401).json({ status: 'error', message: 'Invalid email or password' });
    }

    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      return res.status(401).json({ status: 'error', message: 'Invalid email or password' });
    }

    const token = signToken(user);
    return res.json({ status: 'ok', token, user: publicUser(user) });
  } catch (err) {
    console.error('[auth] login error', err);
    return res.status(500).json({ status: 'error', message: 'Could not log in' });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, full_name, email, role, created_at FROM users WHERE id = $1',
      [req.user.id],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ status: 'error', message: 'User not found' });
    }
    return res.json({ status: 'ok', user: publicUser(result.rows[0]) });
  } catch (err) {
    console.error('[auth] me error', err);
    return res.status(500).json({ status: 'error', message: 'Could not load profile' });
  }
});

export default router;
