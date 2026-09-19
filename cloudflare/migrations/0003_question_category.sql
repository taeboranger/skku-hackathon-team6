-- 질문 주제 분류. department(학과)는 답변자 라우팅용, realtime은 긴급 여부라
-- 주제 축과는 직교한다. 기존 행은 '기타'로 채운 뒤 시드/AI가 다시 분류한다.
ALTER TABLE questions ADD COLUMN category TEXT NOT NULL DEFAULT '기타';

CREATE INDEX idx_questions_category ON questions (category, created_at);
