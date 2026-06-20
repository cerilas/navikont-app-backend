CREATE TABLE IF NOT EXISTS patient_day_completions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    enrollment_id UUID NOT NULL REFERENCES patient_app_enrollments(id) ON DELETE CASCADE,
    day_number INTEGER NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_patient_day_completions_enrollment_id ON patient_day_completions(enrollment_id);
