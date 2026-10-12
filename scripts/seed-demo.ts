/**
 * Fills the local stand-in storage with sample jobs and candidates so the
 * admin screens can be tried out before Google is connected.
 *
 *   npm run seed:demo
 *
 * Refuses to run against Google storage: it must never write sample
 * candidates into a real recruitment spreadsheet.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { APPLICATION_STATUSES, EXPERIENCE_RANGES } from '../shared/constants';
import { jobInputSchema } from '../shared/job-schema';
import { validateApplication } from '../shared/validation';
import { loadConfig } from '../server/config';
import { createContext } from '../server/context';
import { validateResume } from '../server/resume-file';
import { createStorage } from '../server/storage';

for (const name of ['.env.local', '.env']) {
  const file = path.resolve(process.cwd(), name);
  if (existsSync(file)) process.loadEnvFile(file);
}

const FIRST = ['Asha', 'Bilal', 'Chen', 'Divya', 'Esha', 'Farhan', 'Gita', 'Harsh', 'Isha', 'Jatin', 'Kavya', 'Lokesh', 'Meera', 'Nikhil', 'Ojas', 'Priya', 'Rohan', 'Sneha', 'Tarun', 'Uma'];
const LAST = ['Rao', 'Khan', 'Wei', 'Nair', 'Roy', 'Mehta', 'Iyer', 'Shah', 'Verma', 'Das'];
const CITIES = ['Bengaluru', 'Mumbai', 'Pune', 'Hyderabad', 'Chennai', 'Delhi NCR', 'Kochi'];

/** A small, fully valid one-page PDF, so previews and downloads have something real to show. */
function samplePdf(name: string, role: string): Buffer {
  const safe = (text: string) => text.replace(/[\\()]/g, '');
  const content = [
    'BT',
    `/F1 22 Tf 56 730 Td (${safe(name)}) Tj`,
    `/F1 12 Tf 0 -26 Td (Sample resume for ${safe(role)}) Tj`,
    '0 -40 Td (Experience) Tj',
    '0 -18 Td (- Built and shipped products with cross-functional teams) Tj',
    '0 -18 Td (- Sample data created for demonstration only) Tj',
    'ET',
  ].join('\n');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>\nstream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  // The cross-reference table lists where each object starts; viewers rely on it.
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function main() {
  const config = loadConfig();
  if (config.storageBackend !== 'local') {
    throw new Error('Demo data can only be added when STORAGE_BACKEND=local.');
  }
  const { jobs, applications } = createContext(config, createStorage(config));

  const jobInputs = [
    {
      title: 'Senior Backend Engineer',
      description: 'Design and run the services behind our product.\n\nYou will work closely with product and data teams.',
      responsibilities: '- Design and build reliable APIs\n- Review code and mentor engineers\n- Own services in production',
      requirements: '- 5+ years building backend systems\n- Strong SQL and distributed systems knowledge',
      experienceCriteria: '5-8 years in backend engineering',
      questions: [
        { label: 'What is your notice period?', type: 'select', required: true, options: ['Immediate', '30 days', '60 days', '90 days'] },
        { label: 'Are you willing to relocate to Bengaluru?', type: 'yes_no', required: false, options: [] },
      ],
    },
    {
      title: 'Product Designer',
      description: 'Shape how people experience our product, from research to polished interfaces.',
      responsibilities: '- Run discovery with users\n- Design flows and prototypes',
      requirements: '- A portfolio of shipped product work',
      experienceCriteria: '3-5 years in product design',
      questions: [{ label: 'Link to your portfolio', type: 'short_text', required: true, options: [] }],
    },
  ];

  let created = 0;
  for (const [jobIndex, input] of jobInputs.entries()) {
    const job = await jobs.create(jobInputSchema.parse(input), 'Published');
    const count = jobIndex === 0 ? 42 : 14;
    for (let i = 0; i < count; i++) {
      const name = `${FIRST[(i * 7 + jobIndex * 3) % FIRST.length]} ${LAST[(i * 3 + jobIndex) % LAST.length]}`;
      const range = EXPERIENCE_RANGES[(i + jobIndex) % EXPERIENCE_RANGES.length];
      const usd = i % 11 === 5;
      const answers: Record<string, string> = {};
      for (const q of job.questions) {
        answers[q.id] = q.type === 'select' ? q.options[i % q.options.length] : q.type === 'yes_no' ? (i % 3 === 0 ? 'No' : 'Yes') : `https://portfolio.example.com/${i}`;
      }
      const validated = validateApplication(
        {
          fullName: name,
          email: `${name.toLowerCase().replace(/\s+/g, '.')}.${jobIndex}${i}@example.com`,
          phone: `+91 9${String(800000000 + i * 104729 + jobIndex * 7919).padStart(9, '0')}`,
          location: CITIES[i % CITIES.length],
          ctcCurrency: usd ? 'USD' : 'INR',
          ctcAmount: String(usd ? 40000 + i * 1500 : 400000 + ((i * 37) % 60) * 50000),
          experienceRange: range.key,
          experienceYears: range.years.length > 0 ? range.years[i % Math.min(range.years.length, 4)] : '',
          linkedinUrl: `linkedin.com/in/${name.toLowerCase().replace(/\s+/g, '-')}-${jobIndex}${i}`,
          answers,
        },
        job.questions,
      );
      const resume = validateResume({ originalName: 'resume.pdf', data: samplePdf(name, job.title) }, config.maxResumeBytes);
      if (!validated.ok || !resume.ok) throw new Error(`Sample data is invalid: ${JSON.stringify(validated.ok ? resume : validated.errors)}`);
      const { id } = await applications.submit(job, validated.data, resume.resume);
      // Spread candidates across statuses, leaving most as New.
      const status = APPLICATION_STATUSES[i % 9 < 5 ? 0 : (i % 9) - 4];
      if (status !== 'New') await applications.update([id], { status });
      created += 1;
    }
  }
  console.log(`Added ${jobInputs.length} sample jobs and ${created} sample candidates to ${config.localDataDir}.`);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
