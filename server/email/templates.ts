/**
 * Emails sent to candidates. Written for email clients, which is why the HTML
 * uses tables and inline styles and loads nothing from the internet: no images,
 * no fonts, no links to click.
 */

export interface ApplicationReceivedInput {
  companyName: string;
  jobTitle: string;
  candidateName: string;
  applicationId: string;
  /** ISO timestamp of the submission. */
  submittedAt: string;
  /** IANA time zone the date is shown in. */
  timezone: string;
  /** Whether a person reads replies to this email. */
  repliesMonitored: boolean;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const BRAND = '#2548ea';
const INK = '#0f172a';
const BODY = '#334155';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const TINT = '#eef4ff';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The first name, when the name field holds something that reads as a name.
 * Anything else (a web address, a slogan) is left out of the email, so the
 * form cannot be used to send someone a message of the sender's choosing.
 */
export function greetingName(fullName: string): string | null {
  const first = fullName.trim().split(/\s+/)[0] ?? '';
  return first.length <= 30 && /^\p{L}[\p{L}\p{M}'’-]*$/u.test(first) ? first : null;
}

function formatDate(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

const AUTOMATED = 'This is an automated email.';
const NO_REPLY = 'Please do not reply to it, as replies are not read.';

const NEXT_STEPS = [
  { title: 'We review your application', detail: 'Our hiring team reads every application and resume.' },
  { title: 'We contact you if there is a match', detail: 'If your profile fits the role, we will reach out by email or phone.' },
  { title: 'Nothing more to do for now', detail: 'Your details and resume are safely with us.' },
];

/** The "we received your application" email sent right after a candidate applies. */
export function applicationReceivedEmail(input: ApplicationReceivedInput): EmailContent {
  const name = greetingName(input.candidateName);
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const submitted = formatDate(input.submittedAt, input.timezone);
  const replyNote = input.repliesMonitored ? 'Have a question? Just reply to this email.' : `${AUTOMATED} ${NO_REPLY}`;
  const whyNote = `You are receiving this email because an application was submitted to ${input.companyName} with this address. If that was not you, you can ignore this message.`;

  const facts: [string, string][] = [
    ['Position', input.jobTitle],
    ['Reference', input.applicationId],
    ...(submitted ? ([['Submitted', submitted]] as [string, string][]) : []),
  ];

  const subject = `We received your application – ${input.jobTitle}`;

  const text = [
    greeting,
    '',
    `Thank you for applying to ${input.companyName} for the ${input.jobTitle} position. We have received your application.`,
    '',
    'Our team will review your application. If your profile matches the requirements, we will contact you shortly.',
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    '',
    'What happens next',
    ...NEXT_STEPS.map((step, i) => `${i + 1}. ${step.title}. ${step.detail}`),
    '',
    'Best regards,',
    `The ${input.companyName} team`,
    '',
    '--',
    replyNote,
    whyNote,
  ].join('\n');

  const e = escapeHtml;
  const company = e(input.companyName);
  const job = e(input.jobTitle);
  const initial = e([...input.companyName.trim()][0]?.toUpperCase() ?? '');

  // The email fills whatever width the mail app gives it. Blocks sit side by side
  // on a wide screen and stack on a phone. That must work without a media query,
  // which several mail apps ignore: each block is an inline block with a minimum
  // width, so the ones that do not fit drop to the next line, centred. Apps that do
  // honour the media query in <head> also widen the stacked blocks to the full
  // width. Outlook on Windows gets a plain table.
  const columns = (cells: string[], minWidth: number) => {
    const width = Math.floor(99 / cells.length);
    const blocks = cells.map(
      (cell) =>
        `<!--[if mso]><td width="${width}%" valign="top" align="center"><![endif]-->` +
        `<div class="col" style="display:inline-block;width:${width}%;min-width:${minWidth}px;vertical-align:top;">${cell}</div>` +
        `<!--[if mso]></td><![endif]-->`,
    );
    return (
      `<!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><![endif]-->` +
      blocks.join('') +
      `<!--[if mso]></tr></table><![endif]-->`
    );
  };

  const factCells = facts.map(
    ([label, value]) =>
      `<div style="padding:16px 12px;font-family:${FONT};text-align:center;">` +
      `<div style="font-size:11px;line-height:16px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${MUTED};">${e(label)}</div>` +
      `<div style="padding-top:4px;font-size:15px;line-height:22px;font-weight:600;color:${INK};">${e(value)}</div>` +
      `</div>`,
  );

  const stepCells = NEXT_STEPS.map(
    (step, i) =>
      `<div style="padding:12px 16px;font-family:${FONT};text-align:center;">` +
      `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>` +
      `<td align="center" valign="middle" width="36" height="36" style="width:36px;height:36px;border-radius:18px;background:${i === 0 ? BRAND : TINT};font-family:${FONT};font-size:15px;line-height:36px;font-weight:700;color:${i === 0 ? '#ffffff' : BRAND};">${i + 1}</td>` +
      `</tr></table>` +
      `<div style="padding-top:12px;font-size:15px;line-height:22px;font-weight:600;color:${INK};">${e(step.title)}</div>` +
      `<div style="padding-top:2px;font-size:13px;line-height:20px;color:${MUTED};">${e(step.detail)}</div>` +
      `</div>`,
  );

  // Right under the sign-off, where it is read before anyone presses Reply.
  const noReplyRow = input.repliesMonitored
    ? ''
    : `
            <tr>
              <td style="padding:0 28px 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid ${LINE};border-radius:10px;border-collapse:separate;">
                  <tr>
                    <td align="center" style="padding:12px 16px;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};text-align:center;">
                      <strong style="color:${BODY};">${e(AUTOMATED)}</strong> ${e(NO_REPLY)}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`;

  // The do-not-reply notice has its own box above; an invitation to reply goes in the footer.
  const footerNotes = [...(input.repliesMonitored ? [replyNote] : []), whyNote]
    .map((note, i, all) => `                <p style="margin:0${i < all.length - 1 ? ' 0 6px' : ''};">${e(note)}</p>`)
    .join('\n');

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${e(subject)}</title>
    <style>
      @media (max-width: 600px) {
        .col { display: block !important; width: 100% !important; min-width: 0 !important; }
      }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#ffffff;-webkit-text-size-adjust:100%;">
    <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">Thank you for applying to ${company}. Here is what happens next.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff;">
      <tr>
        <td style="padding:12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#ffffff;border:1px solid ${LINE};border-radius:14px;border-collapse:separate;">
            <tr>
              <td bgcolor="${BRAND}" style="background:${BRAND};border-radius:13px 13px 0 0;padding:16px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                  <td align="center" valign="middle" width="34" height="34" style="width:34px;height:34px;border-radius:9px;background:#ffffff;font-family:${FONT};font-size:16px;line-height:34px;font-weight:700;color:${BRAND};">${initial}</td>
                  <td style="padding-left:10px;font-family:${FONT};font-size:16px;line-height:24px;font-weight:600;color:#ffffff;">${company}</td>
                </tr></table>
              </td>
            </tr>
            <tr>
              <td align="center" bgcolor="${TINT}" style="background:${TINT};padding:44px 24px 40px;text-align:center;">
                <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr>
                  <td align="center" valign="middle" width="60" height="60" style="width:60px;height:60px;border-radius:30px;background:#10b981;font-family:${FONT};font-size:30px;line-height:60px;font-weight:700;color:#ffffff;">&#10003;</td>
                </tr></table>
                <h1 style="margin:20px 0 0;font-family:${FONT};font-size:28px;line-height:36px;font-weight:700;color:${INK};letter-spacing:-0.4px;">Application received</h1>
                <table role="presentation" align="center" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;margin:0 auto;"><tr>
                  <td align="center" style="padding-top:16px;font-family:${FONT};font-size:16px;line-height:26px;color:${BODY};text-align:center;">
                    <p style="margin:0 0 10px;">${e(greeting)}</p>
                    <p style="margin:0 0 10px;">Thank you for applying to <strong style="color:${INK};">${company}</strong> for the <strong style="color:${INK};">${job}</strong> position.</p>
                    <p style="margin:0;">Our team will review your application. If your profile matches the requirements, we will contact you shortly.</p>
                  </td>
                </tr></table>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 28px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid ${LINE};border-radius:12px;border-collapse:separate;">
                  <tr>
                    <td align="center" style="padding:4px 8px;text-align:center;font-size:0;">${columns(factCells, 180)}</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:32px 28px 0;text-align:center;">
                <div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${MUTED};padding-bottom:8px;">What happens next</div>
                <div style="font-size:0;">${columns(stepCells, 200)}</div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:24px 28px 24px;font-family:${FONT};font-size:15px;line-height:24px;color:${BODY};text-align:center;">
                <div style="border-top:1px solid ${LINE};padding-top:24px;">Best regards,<br><strong style="color:${INK};">The ${company} team</strong></div>
              </td>
            </tr>${noReplyRow}
            <tr>
              <td align="center" bgcolor="#f8fafc" style="background:#f8fafc;border-top:1px solid ${LINE};border-radius:0 0 13px 13px;padding:18px 28px;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};text-align:center;">
${footerNotes}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

  return { subject, html, text };
}
