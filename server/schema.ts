import type { TableDef } from './storage/tables';

/**
 * Worksheet layout. Header text is what administrators see in Google Sheets;
 * the app finds columns by this text, so the order can be changed freely.
 */

export const JOBS: TableDef = {
  name: 'Jobs',
  idKey: 'id',
  columns: [
    { key: 'id', header: 'Job ID' },
    { key: 'title', header: 'Title' },
    { key: 'status', header: 'Status' },
    { key: 'description', header: 'Description' },
    { key: 'responsibilities', header: 'Responsibilities' },
    { key: 'requirements', header: 'Requirements' },
    { key: 'experienceCriteria', header: 'Experience Criteria' },
    { key: 'questions', header: 'Questions (JSON)' },
    { key: 'driveFolderId', header: 'Drive Folder ID' },
    { key: 'createdAt', header: 'Created At' },
    { key: 'updatedAt', header: 'Updated At' },
  ],
};

export const APPLICATIONS: TableDef = {
  name: 'Applications',
  idKey: 'id',
  columns: [
    { key: 'id', header: 'Application ID' },
    { key: 'jobId', header: 'Job ID' },
    { key: 'jobTitle', header: 'Job Title' },
    { key: 'fullName', header: 'Candidate Name' },
    { key: 'email', header: 'Email' },
    { key: 'phone', header: 'Phone' },
    { key: 'location', header: 'Current Location' },
    { key: 'ctcCurrency', header: 'CTC Currency' },
    { key: 'ctcAmount', header: 'Current Annual CTC', type: 'number' },
    { key: 'experienceRange', header: 'Experience Range' },
    { key: 'experienceYears', header: 'Exact Experience (Years)' },
    { key: 'linkedinUrl', header: 'LinkedIn URL' },
    { key: 'resumeFileId', header: 'Resume File ID' },
    { key: 'resumeFilename', header: 'Resume Filename' },
    { key: 'resumeMimeType', header: 'Resume Type' },
    { key: 'resumeSize', header: 'Resume Size (Bytes)', type: 'number' },
    { key: 'submittedAt', header: 'Submitted At' },
    { key: 'status', header: 'Status' },
    { key: 'notes', header: 'Internal Notes' },
    { key: 'updatedAt', header: 'Updated At' },
  ],
};

export const ANSWERS: TableDef = {
  name: 'Application Answers',
  columns: [
    { key: 'applicationId', header: 'Application ID' },
    { key: 'jobId', header: 'Job ID' },
    { key: 'questionId', header: 'Question ID' },
    { key: 'question', header: 'Question' },
    { key: 'answer', header: 'Answer' },
  ],
};

export const ACTIVITY: TableDef = {
  name: 'Application Activity',
  columns: [
    { key: 'timestamp', header: 'Timestamp' },
    { key: 'applicationId', header: 'Application ID' },
    { key: 'jobId', header: 'Job ID' },
    { key: 'action', header: 'Action' },
    { key: 'detail', header: 'Detail' },
    { key: 'actor', header: 'Actor' },
  ],
};

export const ALL_TABLES: TableDef[] = [JOBS, APPLICATIONS, ANSWERS, ACTIVITY];

export const JOBS_FOLDER_NAME = 'Jobs';
export const ROOT_FOLDER_NAME = 'Recruitment System';
export const SPREADSHEET_NAME = 'Applicants';
