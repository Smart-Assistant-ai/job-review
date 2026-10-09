// Validation for job postings, shared by the admin form and the server.

import { z } from 'zod';
import { LIMITS, type Question } from './constants';
import { cleanLine, cleanText, type FieldErrors } from './validation';

const line = (max: number) => z.string().transform(cleanLine).pipe(z.string().max(max, `Keep this under ${max} characters.`));
const text = (max: number) => z.string().transform(cleanText).pipe(z.string().max(max, `Keep this under ${max} characters.`));

export const questionSchema = z
  .object({
    id: z.string().optional(),
    label: line(LIMITS.questionLabel).pipe(z.string().min(3, 'Write the question.')),
    type: z.enum(['short_text', 'long_text', 'select', 'yes_no']),
    required: z.boolean(),
    options: z
      .array(line(LIMITS.optionLabel))
      .max(LIMITS.optionsPerQuestion, `Use at most ${LIMITS.optionsPerQuestion} options.`)
      .default([]),
  })
  .transform((q) => ({
    ...q,
    // Options only apply to dropdowns; blanks and repeats are dropped.
    options: q.type === 'select' ? [...new Set(q.options.filter(Boolean))] : [],
  }))
  .superRefine((q, ctx) => {
    if (q.type === 'select' && q.options.length < 2) {
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'Add at least two options.' });
    }
  });

export const jobInputSchema = z.object({
  title: line(LIMITS.jobTitle).pipe(z.string().min(3, 'Enter a job title.')),
  description: text(LIMITS.jobLongText).pipe(z.string().min(1, 'Add a job description.')),
  responsibilities: text(LIMITS.jobLongText),
  requirements: text(LIMITS.jobLongText),
  experienceCriteria: line(LIMITS.jobExperienceCriteria),
  questions: z
    .array(questionSchema)
    .max(LIMITS.questionsPerJob, `Use at most ${LIMITS.questionsPerJob} questions.`),
});

export type JobInput = z.infer<typeof jobInputSchema>;

export interface JobFormValues {
  title: string;
  description: string;
  responsibilities: string;
  requirements: string;
  experienceCriteria: string;
  questions: (Omit<Question, 'id'> & { id?: string })[];
}

/** Turns zod issues into `{ "questions.0.label": "message" }`, keeping the first message per field. */
export function zodFieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.');
    if (!(key in errors)) errors[key] = issue.message;
  }
  return errors;
}
