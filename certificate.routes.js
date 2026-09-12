import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { issueCertificateIfComplete, getCourseCompletion } from '../services/certificate.service.js';

const router = Router();

// -----------------------------------------------------------------------
// GET /api/certificates/me — all certificates earned by the current user
// -----------------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cert.*, c.title AS course_title, c.slug AS course_slug
       FROM certificates cert JOIN courses c ON c.id = cert.course_id
       WHERE cert.user_id = $1 ORDER BY cert.issued_at DESC`,
      [req.user.id],
    );
    res.json({ status: 'ok', certificates: rows });
  } catch (err) {
    console.error('[certificate] list error', err);
    res.status(500).json({ status: 'error', message: 'Could not load certificates' });
  }
});

// -----------------------------------------------------------------------
// POST /api/certificates/courses/:courseId/issue
// Self-service "claim my certificate" — issues one if the user has
// completed 100% of the course. Safe to call repeatedly (idempotent);
// this is the same path progress/quiz/assignment routes trigger
// automatically, exposed here in case a client needs to check/retry.
// -----------------------------------------------------------------------
router.post('/courses/:courseId/issue', requireAuth, async (req, res) => {
  try {
    const completion = await getCourseCompletion(req.user.id, req.params.courseId);
    if (completion.percent < 100) {
      return res.status(400).json({
        status: 'error',
        message: `Course is ${completion.percent}% complete — finish all lessons to earn a certificate`,
        completion,
      });
    }
    const certificate = await issueCertificateIfComplete(req.user.id, req.params.courseId);
    res.json({ status: 'ok', certificate });
  } catch (err) {
    console.error('[certificate] issue error', err);
    res.status(500).json({ status: 'error', message: 'Could not issue certificate' });
  }
});

// -----------------------------------------------------------------------
// GET /api/certificates/:id — single certificate (owner or admin)
// Used by certificate.html to render the printable view.
// -----------------------------------------------------------------------
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cert.*, c.title AS course_title, u.full_name AS student_name
       FROM certificates cert
       JOIN courses c ON c.id = cert.course_id
       JOIN users u ON u.id = cert.user_id
       WHERE cert.id = $1`,
      [req.params.id],
    );
    const certificate = rows[0];
    if (!certificate) return res.status(404).json({ status: 'error', message: 'Certificate not found' });
    if (req.user.role !== 'admin' && certificate.user_id !== req.user.id) {
      return res.status(403).json({ status: 'error', message: 'Not your certificate' });
    }
    res.json({ status: 'ok', certificate });
  } catch (err) {
    console.error('[certificate] detail error', err);
    res.status(500).json({ status: 'error', message: 'Could not load certificate' });
  }
});

// -----------------------------------------------------------------------
// GET /api/certificates/verify/:code — PUBLIC verification, no auth.
// Lets anyone (e.g. a hiring manager) confirm a certificate is genuine
// using just the short code printed on it.
// -----------------------------------------------------------------------
router.get('/verify/:code', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT cert.certificate_code, cert.issued_at, c.title AS course_title, u.full_name AS student_name
       FROM certificates cert
       JOIN courses c ON c.id = cert.course_id
       JOIN users u ON u.id = cert.user_id
       WHERE cert.certificate_code = $1`,
      [req.params.code.toUpperCase()],
    );
    if (rows.length === 0) {
      return res.status(404).json({ status: 'error', valid: false, message: 'No certificate found with that code' });
    }
    res.json({ status: 'ok', valid: true, certificate: rows[0] });
  } catch (err) {
    console.error('[certificate] verify error', err);
    res.status(500).json({ status: 'error', message: 'Could not verify certificate' });
  }
});

export default router;
