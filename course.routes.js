import { Router } from 'express';
import { pool } from '../db.js';
import { requireAuth, optionalAuth } from '../middleware/auth.middleware.js';
import { checkRole } from '../middleware/role.middleware.js';

const router = Router();
const CONTENT_TYPES = ['video', 'text', 'assignment', 'quiz'];

function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function uniqueSlug(title) {
  const base = slugify(title) || 'course';
  let slug = base;
  let suffix = 1;
  // Small, bounded loop — course creation is a low-frequency admin action.
  for (;;) {
    const { rows } = await pool.query('SELECT 1 FROM courses WHERE slug = $1', [slug]);
    if (rows.length === 0) return slug;
    suffix += 1;
    slug = `${base}-${suffix}`;
  }
}

/** Loads a course and throws a { status, message } style object if access isn't allowed. */
async function loadCourseForWrite(courseId, user) {
  const { rows } = await pool.query('SELECT * FROM courses WHERE id = $1', [courseId]);
  const course = rows[0];
  if (!course) {
    const err = new Error('Course not found');
    err.httpStatus = 404;
    throw err;
  }
  if (user.role !== 'admin' && course.instructor_id !== user.id) {
    const err = new Error('You do not own this course');
    err.httpStatus = 403;
    throw err;
  }
  return course;
}

async function loadModuleForWrite(moduleId, user) {
  const { rows } = await pool.query(
    `SELECT m.*, c.instructor_id AS course_instructor_id
     FROM modules m JOIN courses c ON c.id = m.course_id
     WHERE m.id = $1`,
    [moduleId],
  );
  const mod = rows[0];
  if (!mod) {
    const err = new Error('Module not found');
    err.httpStatus = 404;
    throw err;
  }
  if (user.role !== 'admin' && mod.course_instructor_id !== user.id) {
    const err = new Error('You do not own the course this module belongs to');
    err.httpStatus = 403;
    throw err;
  }
  return mod;
}

async function loadLessonForWrite(lessonId, user) {
  const { rows } = await pool.query(
    `SELECT l.*, m.course_id AS course_id, c.instructor_id AS course_instructor_id
     FROM lessons l
     JOIN modules m ON m.id = l.module_id
     JOIN courses c ON c.id = m.course_id
     WHERE l.id = $1`,
    [lessonId],
  );
  const lesson = rows[0];
  if (!lesson) {
    const err = new Error('Lesson not found');
    err.httpStatus = 404;
    throw err;
  }
  if (user.role !== 'admin' && lesson.course_instructor_id !== user.id) {
    const err = new Error('You do not own the course this lesson belongs to');
    err.httpStatus = 403;
    throw err;
  }
  return lesson;
}

function handleOwnershipError(err, res) {
  if (err.httpStatus) {
    return res.status(err.httpStatus).json({ status: 'error', message: err.message });
  }
  throw err;
}

// -----------------------------------------------------------------------
// GET /api/courses — list courses
// Published courses are visible to everyone. Instructors additionally see
// their own drafts; admins see everything.
// -----------------------------------------------------------------------
router.get('/', optionalAuth, async (req, res) => {
  try {
    const user = req.user;
    let sql = `
      SELECT c.*, u.full_name AS instructor_name,
        (SELECT COUNT(*) FROM enrollments e WHERE e.course_id = c.id) AS enrollment_count
      FROM courses c
      LEFT JOIN users u ON u.id = c.instructor_id
    `;
    const params = [];
    if (!user) {
      sql += ' WHERE c.is_published = true';
    } else if (user.role === 'admin') {
      // no filter — sees everything
    } else if (user.role === 'instructor') {
      sql += ' WHERE c.is_published = true OR c.instructor_id = $1';
      params.push(user.id);
    } else {
      sql += ' WHERE c.is_published = true';
    }
    sql += ' ORDER BY c.created_at DESC';

    const { rows } = await pool.query(sql, params);
    res.json({ status: 'ok', courses: rows });
  } catch (err) {
    console.error('[courses] list error', err);
    res.status(500).json({ status: 'error', message: 'Could not load courses' });
  }
});

// -----------------------------------------------------------------------
// GET /api/courses/:courseId — full course tree (modules -> lessons)
// -----------------------------------------------------------------------
router.get('/:courseId', optionalAuth, async (req, res) => {
  const { courseId } = req.params;
  try {
    const courseResult = await pool.query(
      `SELECT c.*, u.full_name AS instructor_name FROM courses c
       LEFT JOIN users u ON u.id = c.instructor_id WHERE c.id = $1`,
      [courseId],
    );
    const course = courseResult.rows[0];
    if (!course) return res.status(404).json({ status: 'error', message: 'Course not found' });

    const isOwnerOrAdmin = req.user && (req.user.role === 'admin' || course.instructor_id === req.user.id);
    if (!course.is_published && !isOwnerOrAdmin) {
      return res.status(404).json({ status: 'error', message: 'Course not found' });
    }

    const modulesResult = await pool.query(
      'SELECT * FROM modules WHERE course_id = $1 ORDER BY sort_order, created_at',
      [courseId],
    );
    const moduleIds = modulesResult.rows.map((m) => m.id);

    let lessons = [];
    if (moduleIds.length > 0) {
      const userId = req.user ? req.user.id : null;
      const lessonsResult = await pool.query(
        `SELECT l.*,
                a.instructions AS assignment_instructions, a.max_score AS assignment_max_score,
                q.id AS quiz_id, q.pass_percent AS quiz_pass_percent,
                (SELECT COUNT(*)::int FROM questions WHERE quiz_id = q.id) AS quiz_question_count,
                COALESCE(p.completed, false) AS completed
         FROM lessons l
         LEFT JOIN assignments a ON a.lesson_id = l.id
         LEFT JOIN quizzes q ON q.lesson_id = l.id
         LEFT JOIN progress p ON p.lesson_id = l.id AND p.user_id = $2
         WHERE l.module_id = ANY($1::uuid[])
         ORDER BY l.sort_order, l.created_at`,
        [moduleIds, userId],
      );
      lessons = lessonsResult.rows;
    }

    const modules = modulesResult.rows.map((m) => ({
      ...m,
      lessons: lessons.filter((l) => l.module_id === m.id),
    }));

    res.json({ status: 'ok', course: { ...course, modules } });
  } catch (err) {
    console.error('[courses] detail error', err);
    res.status(500).json({ status: 'error', message: 'Could not load course' });
  }
});

// -----------------------------------------------------------------------
// POST /api/courses — create a course
// -----------------------------------------------------------------------
router.post('/', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  const { title, description } = req.body || {};
  if (!title || typeof title !== 'string' || title.trim().length < 3) {
    return res.status(400).json({ status: 'error', message: 'title must be at least 3 characters' });
  }
  try {
    const slug = await uniqueSlug(title);
    const { rows } = await pool.query(
      `INSERT INTO courses (title, slug, description, instructor_id, is_published)
       VALUES ($1, $2, $3, $4, false) RETURNING *`,
      [title.trim(), slug, description || null, req.user.id],
    );
    res.status(201).json({ status: 'ok', course: rows[0] });
  } catch (err) {
    console.error('[courses] create error', err);
    res.status(500).json({ status: 'error', message: 'Could not create course' });
  }
});

// -----------------------------------------------------------------------
// PUT /api/courses/:courseId — update a course (owner instructor or admin)
// -----------------------------------------------------------------------
router.put('/:courseId', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  try {
    await loadCourseForWrite(req.params.courseId, req.user);
    const { title, description, is_published } = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;

    if (title !== undefined) { fields.push(`title = $${i++}`); values.push(title); }
    if (description !== undefined) { fields.push(`description = $${i++}`); values.push(description); }
    if (is_published !== undefined) { fields.push(`is_published = $${i++}`); values.push(!!is_published); }

    if (fields.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No updatable fields provided' });
    }

    values.push(req.params.courseId);
    const { rows } = await pool.query(
      `UPDATE courses SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    res.json({ status: 'ok', course: rows[0] });
  } catch (err) {
    try { handleOwnershipError(err, res); } catch (e) {
      console.error('[courses] update error', e);
      res.status(500).json({ status: 'error', message: 'Could not update course' });
    }
  }
});

// -----------------------------------------------------------------------
// DELETE /api/courses/:courseId
// -----------------------------------------------------------------------
router.delete('/:courseId', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  try {
    await loadCourseForWrite(req.params.courseId, req.user);
    await pool.query('DELETE FROM courses WHERE id = $1', [req.params.courseId]);
    res.json({ status: 'ok' });
  } catch (err) {
    try { handleOwnershipError(err, res); } catch (e) {
      console.error('[courses] delete error', e);
      res.status(500).json({ status: 'error', message: 'Could not delete course' });
    }
  }
});

// -----------------------------------------------------------------------
// POST /api/courses/:courseId/enroll — self-enroll
// -----------------------------------------------------------------------
router.post('/:courseId/enroll', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM courses WHERE id = $1', [req.params.courseId]);
    const course = rows[0];
    if (!course || !course.is_published) {
      return res.status(404).json({ status: 'error', message: 'Course not found' });
    }
    await pool.query(
      `INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.id, req.params.courseId],
    );
    res.status(201).json({ status: 'ok', message: 'Enrolled' });
  } catch (err) {
    console.error('[courses] enroll error', err);
    res.status(500).json({ status: 'error', message: 'Could not enroll' });
  }
});

// -----------------------------------------------------------------------
// GET /api/courses/me/enrolled — courses the current user is enrolled in,
// with a live completion percentage for each (used by the dashboard).
// -----------------------------------------------------------------------
router.get('/me/enrolled', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, u.full_name AS instructor_name, e.enrolled_at,
              COUNT(DISTINCT l.id)::int AS total_lessons,
              COUNT(DISTINCT p.lesson_id) FILTER (WHERE p.completed)::int AS completed_lessons
       FROM enrollments e
       JOIN courses c ON c.id = e.course_id
       LEFT JOIN users u ON u.id = c.instructor_id
       LEFT JOIN modules m ON m.course_id = c.id
       LEFT JOIN lessons l ON l.module_id = m.id
       LEFT JOIN progress p ON p.lesson_id = l.id AND p.user_id = $1
       WHERE e.user_id = $1
       GROUP BY c.id, u.full_name, e.enrolled_at
       ORDER BY e.enrolled_at DESC`,
      [req.user.id],
    );
    const courses = rows.map((r) => ({
      ...r,
      percent_complete: r.total_lessons > 0 ? Math.round((r.completed_lessons / r.total_lessons) * 100) : 0,
    }));
    res.json({ status: 'ok', courses });
  } catch (err) {
    console.error('[courses] enrolled list error', err);
    res.status(500).json({ status: 'error', message: 'Could not load enrolled courses' });
  }
});

// =========================================================================
// MODULES
// =========================================================================

router.post('/:courseId/modules', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  try {
    await loadCourseForWrite(req.params.courseId, req.user);
    const { title, sort_order } = req.body || {};
    if (!title || typeof title !== 'string' || title.trim().length < 2) {
      return res.status(400).json({ status: 'error', message: 'title must be at least 2 characters' });
    }
    const { rows } = await pool.query(
      `INSERT INTO modules (course_id, title, sort_order) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.courseId, title.trim(), Number.isInteger(sort_order) ? sort_order : 0],
    );
    res.status(201).json({ status: 'ok', module: rows[0] });
  } catch (err) {
    try { handleOwnershipError(err, res); } catch (e) {
      console.error('[modules] create error', e);
      res.status(500).json({ status: 'error', message: 'Could not create module' });
    }
  }
});

router.put('/modules/:moduleId', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  try {
    await loadModuleForWrite(req.params.moduleId, req.user);
    const { title, sort_order } = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;
    if (title !== undefined) { fields.push(`title = $${i++}`); values.push(title); }
    if (sort_order !== undefined) { fields.push(`sort_order = $${i++}`); values.push(sort_order); }
    if (fields.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No updatable fields provided' });
    }
    values.push(req.params.moduleId);
    const { rows } = await pool.query(
      `UPDATE modules SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    res.json({ status: 'ok', module: rows[0] });
  } catch (err) {
    try { handleOwnershipError(err, res); } catch (e) {
      console.error('[modules] update error', e);
      res.status(500).json({ status: 'error', message: 'Could not update module' });
    }
  }
});

router.delete('/modules/:moduleId', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  try {
    await loadModuleForWrite(req.params.moduleId, req.user);
    await pool.query('DELETE FROM modules WHERE id = $1', [req.params.moduleId]);
    res.json({ status: 'ok' });
  } catch (err) {
    try { handleOwnershipError(err, res); } catch (e) {
      console.error('[modules] delete error', e);
      res.status(500).json({ status: 'error', message: 'Could not delete module' });
    }
  }
});

// =========================================================================
// LESSONS
// =========================================================================

router.post('/modules/:moduleId/lessons', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  const client = await pool.connect();
  try {
    await loadModuleForWrite(req.params.moduleId, req.user);
    const {
      title, content_type, video_url, body, duration_minutes, sort_order,
      instructions, max_score, pass_percent,
    } = req.body || {};

    if (!title || typeof title !== 'string' || title.trim().length < 2) {
      return res.status(400).json({ status: 'error', message: 'title must be at least 2 characters' });
    }
    if (!CONTENT_TYPES.includes(content_type)) {
      return res.status(400).json({ status: 'error', message: `content_type must be one of: ${CONTENT_TYPES.join(', ')}` });
    }
    if (content_type === 'assignment' && (!instructions || typeof instructions !== 'string')) {
      return res.status(400).json({ status: 'error', message: 'assignment lessons require instructions' });
    }

    await client.query('BEGIN');

    const lessonResult = await client.query(
      `INSERT INTO lessons (module_id, title, content_type, video_url, body, duration_minutes, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        req.params.moduleId, title.trim(), content_type,
        video_url || null, body || null,
        Number.isInteger(duration_minutes) ? duration_minutes : null,
        Number.isInteger(sort_order) ? sort_order : 0,
      ],
    );
    const lesson = lessonResult.rows[0];

    if (content_type === 'assignment') {
      await client.query(
        `INSERT INTO assignments (lesson_id, title, instructions, max_score) VALUES ($1, $2, $3, $4)`,
        [lesson.id, title.trim(), instructions, Number.isInteger(max_score) ? max_score : 100],
      );
    } else if (content_type === 'quiz') {
      await client.query(
        `INSERT INTO quizzes (lesson_id, title, pass_percent) VALUES ($1, $2, $3)`,
        [lesson.id, title.trim(), Number.isInteger(pass_percent) ? pass_percent : 70],
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ status: 'ok', lesson });
  } catch (err) {
    await client.query('ROLLBACK');
    try { handleOwnershipError(err, res); } catch (e) {
      console.error('[lessons] create error', e);
      res.status(500).json({ status: 'error', message: 'Could not create lesson' });
    }
  } finally {
    client.release();
  }
});

router.put('/lessons/:lessonId', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  try {
    await loadLessonForWrite(req.params.lessonId, req.user);
    const { title, video_url, body, duration_minutes, sort_order } = req.body || {};
    const fields = [];
    const values = [];
    let i = 1;
    if (title !== undefined) { fields.push(`title = $${i++}`); values.push(title); }
    if (video_url !== undefined) { fields.push(`video_url = $${i++}`); values.push(video_url); }
    if (body !== undefined) { fields.push(`body = $${i++}`); values.push(body); }
    if (duration_minutes !== undefined) { fields.push(`duration_minutes = $${i++}`); values.push(duration_minutes); }
    if (sort_order !== undefined) { fields.push(`sort_order = $${i++}`); values.push(sort_order); }
    if (fields.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No updatable fields provided' });
    }
    values.push(req.params.lessonId);
    const { rows } = await pool.query(
      `UPDATE lessons SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
      values,
    );
    res.json({ status: 'ok', lesson: rows[0] });
  } catch (err) {
    try { handleOwnershipError(err, res); } catch (e) {
      console.error('[lessons] update error', e);
      res.status(500).json({ status: 'error', message: 'Could not update lesson' });
    }
  }
});

router.delete('/lessons/:lessonId', requireAuth, checkRole(['instructor', 'admin']), async (req, res) => {
  try {
    await loadLessonForWrite(req.params.lessonId, req.user);
    await pool.query('DELETE FROM lessons WHERE id = $1', [req.params.lessonId]);
    res.json({ status: 'ok' });
  } catch (err) {
    try { handleOwnershipError(err, res); } catch (e) {
      console.error('[lessons] delete error', e);
      res.status(500).json({ status: 'error', message: 'Could not delete lesson' });
    }
  }
});

export default router;
