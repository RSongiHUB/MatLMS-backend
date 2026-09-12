import bcrypt from 'bcrypt';
import { pool } from './db.js';

const SALT_ROUNDS = 12;
const EXCEL_MASTERY_COURSE_ID = '00000000-0000-4000-8000-000000000001';

// Demo accounts. Passwords are overridable via .env so nobody is stuck with
// these in a real deployment — see .env.example.
const DEMO_USERS = [
  {
    full_name: 'Ananya Admin',
    email: 'admin@matrixlms.dev',
    role: 'admin',
    password: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
  },
  {
    full_name: 'Ishaan Instructor',
    email: 'instructor@matrixlms.dev',
    role: 'instructor',
    password: process.env.SEED_INSTRUCTOR_PASSWORD || 'Instructor@12345',
  },
  {
    full_name: 'Sara Student',
    email: 'student1@matrixlms.dev',
    role: 'student',
    password: process.env.SEED_STUDENT_PASSWORD || 'Student@12345',
  },
  {
    full_name: 'Aman Student',
    email: 'student2@matrixlms.dev',
    role: 'student',
    password: process.env.SEED_STUDENT_PASSWORD || 'Student@12345',
  },
];

/**
 * Why this lives in application code and not in database/seed.sql:
 * password_hash must be a real bcrypt hash, and the SQL init scripts have
 * no access to a hashing library. Running this once, on first boot, keeps
 * seeding declarative (SQL) for content and correct (bcrypt) for secrets.
 * It's fully idempotent — safe to run on every container start.
 */
export async function runApplicationSeed() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM users');

  if (rows[0].count > 0) {
    console.log('[seed] users table already populated — skipping demo account seed');
    return;
  }

  console.log('[seed] no users found — creating demo accounts');

  const insertedIds = {};
  for (const u of DEMO_USERS) {
    const hash = await bcrypt.hash(u.password, SALT_ROUNDS);
    const result = await pool.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, role`,
      [u.full_name, u.email, hash, u.role],
    );
    if (result.rows[0]) {
      insertedIds[u.role] = insertedIds[u.role] || [];
      insertedIds[u.role].push(result.rows[0].id);
    }
  }

  // Link the seeded instructor to the Excel Mastery course from seed.sql,
  // and enroll both demo students so the dashboard has something to show.
  const instructorId = insertedIds.instructor && insertedIds.instructor[0];
  if (instructorId) {
    await pool.query('UPDATE courses SET instructor_id = $1 WHERE id = $2', [
      instructorId,
      EXCEL_MASTERY_COURSE_ID,
    ]);
  }

  const studentIds = insertedIds.student || [];
  for (const studentId of studentIds) {
    await pool.query(
      `INSERT INTO enrollments (user_id, course_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [studentId, EXCEL_MASTERY_COURSE_ID],
    );
  }

  console.log('[seed] demo accounts ready — sign in with:');
  DEMO_USERS.forEach((u) => {
    console.log(`  - ${u.role.padEnd(10)} ${u.email} / ${u.password}`);
  });
}
