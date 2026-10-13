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
const PAGE = '#f3f5f9';

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

  // The layout every mail app renders the same way: one column, 600px at most,
  // centred, with the text left-aligned. Wider than that and lines get hard to read;
  // side-by-side blocks break in some apps.
  const factRows = facts
    .map(
      ([label, value], i) => `
                        <tr>
                          <td width="84" style="width:84px;padding:13px 0 13px 16px;${i > 0 ? `border-top:1px solid ${LINE};` : ''}font-family:${FONT};font-size:14px;line-height:22px;color:${MUTED};vertical-align:top;white-space:nowrap;">${e(label)}</td>
                          <td style="padding:13px 16px 13px 12px;${i > 0 ? `border-top:1px solid ${LINE};` : ''}font-family:${FONT};font-size:15px;line-height:22px;color:${INK};font-weight:600;vertical-align:top;">${e(value)}</td>
                        </tr>`,
    )
    .join('');

  const stepRows = NEXT_STEPS.map(
    (step, i) => `
                        <tr>
                          <td width="44" style="width:44px;padding:0 0 ${i < NEXT_STEPS.length - 1 ? 18 : 0}px 0;vertical-align:top;">
                            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                              <td align="center" valign="middle" width="30" height="30" style="width:30px;height:30px;border-radius:15px;background:${i === 0 ? BRAND : TINT};font-family:${FONT};font-size:14px;line-height:30px;font-weight:700;color:${i === 0 ? '#ffffff' : BRAND};">${i + 1}</td>
                            </tr></table>
                          </td>
                          <td style="padding:0 0 ${i < NEXT_STEPS.length - 1 ? 18 : 0}px 0;vertical-align:top;font-family:${FONT};">
                            <div style="font-size:15px;line-height:22px;font-weight:600;color:${INK};padding-top:4px;">${e(step.title)}</div>
                            <div style="font-size:14px;line-height:22px;color:${MUTED};">${e(step.detail)}</div>
                          </td>
                        </tr>`,
  ).join('');

  // The last thing in the card, where it is read before anyone presses Reply.
  const cardNote = input.repliesMonitored
    ? e(replyNote)
    : `<strong style="color:${BODY};">${e(AUTOMATED)}</strong> ${e(NO_REPLY)}`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${e(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:${PAGE};-webkit-text-size-adjust:100%;">
    <div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;color:transparent;">Thank you for applying to ${company}. Here is what happens next.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="width:100%;background:${PAGE};">
      <tr>
        <td align="center" style="padding:32px 12px 40px;">
          <!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
            <tr>
              <td style="background:#ffffff;border:1px solid ${LINE};border-radius:14px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="${BRAND}" style="background:${BRAND};border-radius:13px 13px 0 0;padding:20px 32px;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                        <td align="center" valign="middle" width="36" height="36" style="width:36px;height:36px;border-radius:9px;background:#ffffff;font-family:${FONT};font-size:17px;line-height:36px;font-weight:700;color:${BRAND};">${initial}</td>
                        <td style="padding-left:12px;font-family:${FONT};font-size:17px;line-height:24px;font-weight:600;color:#ffffff;">${company}</td>
                      </tr></table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:36px 32px 0;">
                      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                        <td align="center" valign="middle" width="40" height="40" style="width:40px;height:40px;border-radius:20px;background:#10b981;font-family:${FONT};font-size:20px;line-height:40px;font-weight:700;color:#ffffff;">&#10003;</td>
                        <td style="padding-left:14px;">
                          <h1 style="margin:0;font-family:${FONT};font-size:24px;line-height:32px;font-weight:700;color:${INK};letter-spacing:-0.3px;">Application received</h1>
                        </td>
                      </tr></table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:24px 32px 0;font-family:${FONT};font-size:16px;line-height:26px;color:${BODY};">
                      <p style="margin:0 0 14px;">${e(greeting)}</p>
                      <p style="margin:0 0 14px;">Thank you for applying to <strong style="color:${INK};">${company}</strong> for the <strong style="color:${INK};">${job}</strong> position.</p>
                      <p style="margin:0;">Our team will review your application. If your profile matches the requirements, we will contact you shortly.</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:28px 32px 0;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid ${LINE};border-radius:10px;border-collapse:separate;">${factRows}
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:32px 32px 0;">
                      <h2 style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:24px;font-weight:700;color:${INK};">What happens next</h2>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${stepRows}
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:32px 32px 32px;font-family:${FONT};font-size:16px;line-height:26px;color:${BODY};">
                      Best regards,<br><strong style="color:${INK};">The ${company} team</strong>
                    </td>
                  </tr>
                  <tr>
                    <td bgcolor="#f8fafc" style="background:#f8fafc;border-top:1px solid ${LINE};border-radius:0 0 13px 13px;padding:16px 32px;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};">
                      ${cardNote}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px 20px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};text-align:center;">
                ${e(whyNote)}
              </td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
        </td>
      </tr>
    </table>
  </body>
</html>
`;

  return { subject, html, text };
}
