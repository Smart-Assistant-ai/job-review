import { RESUME_MIME_TYPES, type ResumeExtension } from '../shared/constants';
import { formatFileSize, resumeExtension } from '../shared/validation';

export interface ValidResume {
  extension: ResumeExtension;
  mimeType: string;
  data: Buffer;
}

const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Checks that the bytes really are the kind of document the extension claims. */
function contentMatches(extension: ResumeExtension, data: Buffer): boolean {
  switch (extension) {
    case 'pdf':
      // The PDF marker is normally the very first bytes; allow a little leading junk.
      return data.subarray(0, 1024).includes('%PDF-');
    case 'doc':
      return data.subarray(0, 8).equals(OLE_SIGNATURE);
    case 'docx':
      // A DOCX is a ZIP archive containing Word parts.
      return (
        data.subarray(0, 4).equals(ZIP_SIGNATURE) &&
        data.includes('[Content_Types].xml') &&
        data.includes('word/')
      );
  }
}

/**
 * Validates an uploaded resume by extension, size and file signature.
 * The browser-supplied MIME type is ignored because it cannot be trusted.
 */
export function validateResume(
  file: { originalName: string; data: Buffer } | null,
  maxBytes: number,
): { ok: true; resume: ValidResume } | { ok: false; error: string } {
  if (!file) return { ok: false, error: 'Attach your resume.' };
  const extension = resumeExtension(file.originalName);
  if (!extension) return { ok: false, error: 'Upload your resume as a PDF, DOC or DOCX file.' };
  if (file.data.length === 0) return { ok: false, error: 'This file is empty. Choose another file.' };
  if (file.data.length > maxBytes) {
    return { ok: false, error: `This file is too large. The limit is ${formatFileSize(maxBytes)}.` };
  }
  if (!contentMatches(extension, file.data)) {
    return {
      ok: false,
      error: `This file does not look like a valid ${extension.toUpperCase()} document. Export it again and retry.`,
    };
  }
  return { ok: true, resume: { extension, mimeType: RESUME_MIME_TYPES[extension], data: file.data } };
}

/** Makes text safe to use as a file or folder name in Drive and inside ZIP archives. */
export function safeName(value: string, maxLength: number, fallback: string): string {
  const cleaned = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} ._'()&-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, maxLength)
    .trim();
  return cleaned || fallback;
}

/** The application ID in the name guarantees uniqueness, so files never overwrite each other. */
export function buildResumeFilename(candidateName: string, applicationId: string, extension: ResumeExtension): string {
  return `${safeName(candidateName, 60, 'Candidate')} - ${applicationId}.${extension}`;
}
