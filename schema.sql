-- =====================================================================
-- Matrix LMS — Database Schema
-- Runs automatically on first container boot via /docker-entrypoint-initdb.d
-- (mounted as 001_schema.sql — see docker-compose.yml)
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- provides gen_random_uuid()

-- ---------------------------------------------------------------------
-- updated_at trigger helper
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'student'
                   CHECK (role IN ('admin', 'instructor', 'student')),
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_role ON users(role);

CREATE TRIGGER set_updated_at_users
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------------------------------------------------------------------
-- courses
-- ---------------------------------------------------------------------
CREATE TABLE courses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title          TEXT NOT NULL,
  slug           TEXT NOT NULL UNIQUE,
  description    TEXT,
  instructor_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  is_published   BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_courses_instructor ON courses(instructor_id);
CREATE INDEX idx_courses_published ON courses(is_published);

CREATE TRIGGER set_updated_at_courses
BEFORE UPDATE ON courses
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------------------------------------------------------------------
-- modules (groups lessons within a course — powers the sidebar)
-- ---------------------------------------------------------------------
CREATE TABLE modules (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id    UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_modules_course ON modules(course_id);

CREATE TRIGGER set_updated_at_modules
BEFORE UPDATE ON modules
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------------------------------------------------------------------
-- lessons
-- ---------------------------------------------------------------------
CREATE TABLE lessons (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id        UUID NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  content_type     TEXT NOT NULL
                     CHECK (content_type IN ('video', 'text', 'assignment', 'quiz')),
  video_url        TEXT,
  body             TEXT,              -- HTML/markdown body for text lessons, notes for video lessons
  duration_minutes INT,
  sort_order       INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_lessons_module ON lessons(module_id);
CREATE INDEX idx_lessons_type ON lessons(content_type);

CREATE TRIGGER set_updated_at_lessons
BEFORE UPDATE ON lessons
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------------------------------------------------------------------
-- quizzes (one-to-one with a 'quiz' type lesson)
-- ---------------------------------------------------------------------
CREATE TABLE quizzes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id     UUID NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  pass_percent  INT NOT NULL DEFAULT 70 CHECK (pass_percent BETWEEN 0 AND 100),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER set_updated_at_quizzes
BEFORE UPDATE ON quizzes
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------------------------------------------------------------------
-- questions
-- ---------------------------------------------------------------------
CREATE TABLE questions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id        UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  prompt         TEXT NOT NULL,
  options        JSONB NOT NULL,      -- e.g. ["Option A", "Option B", "Option C", "Option D"]
  correct_index  INT NOT NULL,
  explanation    TEXT,
  sort_order     INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_questions_quiz ON questions(quiz_id);

-- ---------------------------------------------------------------------
-- quiz_attempts
-- ---------------------------------------------------------------------
CREATE TABLE quiz_attempts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id        UUID NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score_percent  INT NOT NULL,
  passed         BOOLEAN NOT NULL,
  answers        JSONB NOT NULL,      -- { "<question_id>": <chosen_index> }
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_quiz_attempts_user ON quiz_attempts(user_id);
CREATE INDEX idx_quiz_attempts_quiz ON quiz_attempts(quiz_id);

-- ---------------------------------------------------------------------
-- assignments (one-to-one with an 'assignment' type lesson)
-- ---------------------------------------------------------------------
CREATE TABLE assignments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id     UUID NOT NULL UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  instructions  TEXT NOT NULL,
  max_score     INT NOT NULL DEFAULT 100,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER set_updated_at_assignments
BEFORE UPDATE ON assignments
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- ---------------------------------------------------------------------
-- assignment_submissions
-- ---------------------------------------------------------------------
CREATE TABLE assignment_submissions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id     UUID NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  submission_text   TEXT,
  submission_url    TEXT,
  status            TEXT NOT NULL DEFAULT 'submitted'
                      CHECK (status IN ('submitted', 'graded')),
  score             INT,
  feedback          TEXT,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  graded_at         TIMESTAMPTZ,
  graded_by         UUID REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_submissions_user ON assignment_submissions(user_id);
CREATE INDEX idx_submissions_assignment ON assignment_submissions(assignment_id);

-- ---------------------------------------------------------------------
-- enrollments (which students are enrolled in which course)
-- ---------------------------------------------------------------------
CREATE TABLE enrollments (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id     UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, course_id)
);
CREATE INDEX idx_enrollments_course ON enrollments(course_id);

-- ---------------------------------------------------------------------
-- progress (per-user, per-lesson completion)
-- ---------------------------------------------------------------------
CREATE TABLE progress (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id      UUID NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed      BOOLEAN NOT NULL DEFAULT false,
  completed_at   TIMESTAMPTZ,
  UNIQUE (user_id, lesson_id)
);
CREATE INDEX idx_progress_user ON progress(user_id);
CREATE INDEX idx_progress_lesson ON progress(lesson_id);

-- ---------------------------------------------------------------------
-- certificates
-- ---------------------------------------------------------------------
CREATE TABLE certificates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id          UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  certificate_code   TEXT NOT NULL UNIQUE,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, course_id)
);
CREATE INDEX idx_certificates_user ON certificates(user_id);
