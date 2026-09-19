CREATE TABLE `answers` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `idx_answers_question_author` ON `answers` (`question_id`,`author_id`);
CREATE TABLE `channel_drafts` (
	`chat_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`body` text NOT NULL,
	`target_hint` text DEFAULT '' NOT NULL,
	`stage` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);

CREATE TABLE `ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`delta` integer NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `idx_ledger_user` ON `ledger` (`user_id`);
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`department` text NOT NULL,
	`student_id` text NOT NULL,
	`points` integer DEFAULT 100 NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`location_at` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);

CREATE UNIQUE INDEX `profiles_auth_id_unique` ON `profiles` (`auth_id`);
CREATE UNIQUE INDEX `profiles_student_id_unique` ON `profiles` (`student_id`);
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`author_id` text NOT NULL,
	`request_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`department` text NOT NULL,
	`location` text NOT NULL,
	`target_hint` text NOT NULL,
	`realtime` integer NOT NULL,
	`answer_type` text NOT NULL,
	`tags` text NOT NULL,
	`ai_answer` text,
	`sources` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`channel_chat_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `idx_questions_author_request` ON `questions` (`author_id`,`request_id`);
CREATE INDEX `idx_questions_created` ON `questions` (`created_at`);
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reason` text NOT NULL,
	`score` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`seen_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `questions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE UNIQUE INDEX `idx_requests_question_user` ON `requests` (`question_id`,`user_id`);
CREATE INDEX `idx_requests_user_status` ON `requests` (`user_id`,`status`);
CREATE INDEX `idx_requests_expiry` ON `requests` (`status`,`expires_at`);
CREATE TABLE `subscriptions` (
	`endpoint` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE INDEX `idx_subscriptions_user` ON `subscriptions` (`user_id`);
CREATE TABLE campus_accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE campus_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES campus_accounts(id), expires_at INTEGER NOT NULL);
CREATE INDEX campus_sessions_expiry ON campus_sessions(expires_at);
CREATE TABLE campus_auth_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until_at INTEGER NOT NULL);

ALTER TABLE events ADD COLUMN reply_text TEXT;
ALTER TABLE events ADD COLUMN chat_id TEXT;
ALTER TABLE profiles ADD COLUMN lat REAL;
ALTER TABLE profiles ADD COLUMN lng REAL;
ALTER TABLE questions ADD COLUMN lat REAL;
ALTER TABLE questions ADD COLUMN lng REAL;

