-- =====================================================================
-- Matrix LMS — Seed Data
-- Runs automatically after schema.sql via /docker-entrypoint-initdb.d
-- (mounted as 002_seed.sql — see docker-compose.yml)
--
-- NOTE ON USERS: demo user accounts (admin/instructor/students) are
-- intentionally NOT created here. Password hashing must go through
-- bcrypt, and this script has no access to a hashing library — baking
-- in a hand-typed bcrypt hash would be unverifiable and risk shipping
-- a login that silently never works. Instead, backend/src/seed.js runs
-- once on first container boot, hashes real passwords with bcrypt, and
-- links the seeded instructor below to this course. See README.md.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Course: Excel Mastery for New Joiners
-- ---------------------------------------------------------------------
INSERT INTO courses (id, title, slug, description, instructor_id, is_published) VALUES
('00000000-0000-4000-8000-000000000001',
 'Excel Mastery for New Joiners',
 'excel-mastery',
 'A three-module onboarding course covering Excel basics, formulas & functions, and data analysis with Pivot Tables.',
 NULL, -- linked to the seeded instructor by backend/src/seed.js
 true);

-- ---------------------------------------------------------------------
-- Modules
-- ---------------------------------------------------------------------
INSERT INTO modules (id, course_id, title, sort_order) VALUES
('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'Module 1: Excel Basics', 1),
('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'Module 2: Formulas & Functions', 2),
('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000001', 'Module 3: Data Analysis & Pivot Tables', 3);

-- ---------------------------------------------------------------------
-- Module 1 lessons
-- ---------------------------------------------------------------------
INSERT INTO lessons (id, module_id, title, content_type, video_url, body, duration_minutes, sort_order) VALUES
('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000011',
 'Excel Basics for Beginners', 'video',
 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
 'The grid is made of cells, referenced by column letter + row number (e.g. B4). A workbook can hold many sheets. Formulas always start with =.',
 18, 1),
('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000011',
 'Build a Monthly Expense Tracker', 'assignment', NULL, NULL, 25, 2),
('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000011',
 'Excel Basics Knowledge Check', 'quiz', NULL, NULL, 10, 3);

INSERT INTO assignments (lesson_id, title, instructions, max_score) VALUES
('00000000-0000-4000-8000-000000000102',
 'Build a Monthly Expense Tracker',
 'Download the practice workbook, add a Total (SUM) and Average (AVERAGE) row beneath the five sample expenses, then submit your file or paste your formulas below.',
 100);

INSERT INTO quizzes (id, lesson_id, title, pass_percent) VALUES
('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000103', 'Excel Basics Knowledge Check', 70);

INSERT INTO questions (quiz_id, prompt, options, correct_index, explanation, sort_order) VALUES
('00000000-0000-4000-8000-000000000201', 'In the reference "D8", what does the 8 refer to?',
 '["The row number", "The column number", "The sheet number", "The cell''s value"]', 0,
 'The letter is the column (D) and the number is the row (8) — together they name one cell.', 1),
('00000000-0000-4000-8000-000000000201', 'Which formula adds up a range of cells, like B2:B6?',
 '["=TOTAL(B2:B6)", "=SUM(B2:B6)", "=ADD(B2:B6)", "=PLUS(B2:B6)"]', 1,
 'SUM() is Excel''s built-in function for adding a range of numbers.', 2),
('00000000-0000-4000-8000-000000000201', 'What must every Excel formula begin with?',
 '["A cell reference", "The word FORMULA", "An equals sign (=)", "A dollar sign ($)"]', 2,
 'Excel only treats an entry as a formula, rather than plain text, when it starts with =.', 3);

-- ---------------------------------------------------------------------
-- Module 2 lessons
-- ---------------------------------------------------------------------
INSERT INTO lessons (id, module_id, title, content_type, video_url, body, duration_minutes, sort_order) VALUES
('00000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000012',
 'IF, VLOOKUP and Absolute References', 'video',
 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
 'IF(condition, value_if_true, value_if_false) branches on a test. A dollar sign locks part of a reference when copying. VLOOKUP(value, table, col_index, FALSE) looks up an exact match.',
 22, 1),
('00000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000012',
 'Sales Bonus Calculator', 'assignment', NULL, NULL, 30, 2),
('00000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000012',
 'Formulas & Functions Knowledge Check', 'quiz', NULL, NULL, 10, 3);

INSERT INTO assignments (lesson_id, title, instructions, max_score) VALUES
('00000000-0000-4000-8000-000000000105',
 'Sales Bonus Calculator',
 'Using the practice workbook, write an IF formula to flag whether each employee met the ₹50,000 sales target, then calculate a 10% bonus for those who did.',
 100);

INSERT INTO quizzes (id, lesson_id, title, pass_percent) VALUES
('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000106', 'Formulas & Functions Knowledge Check', 70);

INSERT INTO questions (quiz_id, prompt, options, correct_index, explanation, sort_order) VALUES
('00000000-0000-4000-8000-000000000202', '=IF(B2>=50000,"Yes","No") — if B2 is 45000, what does the formula return?',
 '["Yes", "No", "TRUE", "An error"]', 1,
 '45000 is less than 50000, so the condition is false and the formula returns the "No" value.', 1),
('00000000-0000-4000-8000-000000000202', 'Which symbol locks a cell reference so it doesn''t shift when copied?',
 '["#", "&", "$", "@"]', 2,
 'A dollar sign in front of the column and/or row (like $B$2) fixes that part of the reference.', 2),
('00000000-0000-4000-8000-000000000202', 'In VLOOKUP, setting the last argument to FALSE means:',
 '["Search the whole workbook", "Only an exact match is accepted", "Ignore blank cells", "Sort the results"]', 1,
 'FALSE tells VLOOKUP to return a result only when it finds an exact match to the lookup value.', 3);

-- ---------------------------------------------------------------------
-- Module 3 lessons
-- ---------------------------------------------------------------------
INSERT INTO lessons (id, module_id, title, content_type, video_url, body, duration_minutes, sort_order) VALUES
('00000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000013',
 'Building Your First Pivot Table', 'video',
 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
 'A Pivot Table summarises raw rows by dragging fields into Rows, Columns and Values. Numeric fields default to Sum. Refresh after source data changes.',
 20, 1),
('00000000-0000-4000-8000-000000000108', '00000000-0000-4000-8000-000000000013',
 'Regional Sales Pivot Table', 'assignment', NULL, NULL, 30, 2),
('00000000-0000-4000-8000-000000000109', '00000000-0000-4000-8000-000000000013',
 'Data Analysis & Pivot Tables Knowledge Check', 'quiz', NULL, NULL, 10, 3);

INSERT INTO assignments (lesson_id, title, instructions, max_score) VALUES
('00000000-0000-4000-8000-000000000108',
 'Regional Sales Pivot Table',
 'Build a Pivot Table from the raw sales data with Region in Rows and Revenue in Values, then submit the Grand Total you calculate.',
 100);

INSERT INTO quizzes (id, lesson_id, title, pass_percent) VALUES
('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000109', 'Data Analysis & Pivot Tables Knowledge Check', 70);

INSERT INTO questions (quiz_id, prompt, options, correct_index, explanation, sort_order) VALUES
('00000000-0000-4000-8000-000000000203', 'When you drag a numeric field into a Pivot Table''s Values area, it defaults to:',
 '["Count", "Sum", "Average", "Maximum"]', 1,
 'Numeric fields default to Sum; text fields default to Count. You can change this in Value Field Settings.', 1),
('00000000-0000-4000-8000-000000000203', 'Your source data changed after you built the Pivot Table. What do you click?',
 '["Save", "Refresh", "Undo", "Filter"]', 1,
 'Pivot Tables don''t update automatically — use Refresh (or PivotTable Analyze → Refresh) to pull in the latest data.', 2),
('00000000-0000-4000-8000-000000000203', 'Which feature pairs naturally with a Pivot Table for a visual summary?',
 '["Conditional Formatting", "Pivot Chart", "Data Validation", "Freeze Panes"]', 1,
 'A Pivot Chart is built directly from a Pivot Table and updates with it.', 3);
