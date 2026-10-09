import type { AppConfig } from '../config';
import { ALL_TABLES } from '../schema';
import { createGoogleClients, GoogleDriveBackend, GoogleSheetBackend } from './google';
import { LOCAL_ROOT_FOLDER_ID, LocalDriveBackend, LocalSheetBackend } from './local';
import { TableStore } from './tables';
import { StorageError, type DriveBackend } from './types';

export interface Storage {
  kind: 'google' | 'local';
  tables: TableStore;
  drive: DriveBackend;
  /** The "Recruitment System" folder that holds the Jobs folder. */
  rootFolderId: string;
}

/** A Drive backend that reports the missing configuration on every call. */
function unconfiguredDrive(message: string): DriveBackend {
  const fail = async (): Promise<never> => {
    throw new StorageError('config', message);
  };
  return {
    findFolder: fail,
    createFolder: fail,
    rename: fail,
    uploadFile: fail,
    downloadFile: fail,
    trash: fail,
  };
}

export function createStorage(config: AppConfig): Storage {
  if (config.storageBackend === 'local') {
    return {
      kind: 'local',
      tables: new TableStore(new LocalSheetBackend(config.localDataDir), ALL_TABLES),
      drive: new LocalDriveBackend(config.localDataDir),
      rootFolderId: LOCAL_ROOT_FOLDER_ID,
    };
  }

  /** Starts anyway so the admin screen can explain the problem, but every storage call fails with it. */
  const unconfigured = (message: string): Storage => {
    const fail = async (): Promise<never> => {
      throw new StorageError('config', message);
    };
    return {
      kind: 'google',
      tables: new TableStore({ ensureTabs: fail, readTab: fail, appendRows: fail, writeCells: fail }, ALL_TABLES),
      drive: unconfiguredDrive(message),
      rootFolderId: '',
    };
  };

  if (!config.google) {
    const how =
      config.googleAuthMode === 'service_account'
        ? 'Add the service account key (see README, "Connect Google").'
        : 'Run "npm run google:setup".';
    return unconfigured(`Google storage is not configured. Missing: ${config.googleMissing.join(', ')}. ${how}`);
  }

  try {
    const { sheets, drive } = createGoogleClients(config.google.auth);
    return {
      kind: 'google',
      tables: new TableStore(new GoogleSheetBackend(sheets, config.google.sheetId), ALL_TABLES),
      drive: new GoogleDriveBackend(drive),
      rootFolderId: config.google.rootFolderId,
    };
  } catch (err) {
    if (err instanceof StorageError) return unconfigured(err.message);
    throw err;
  }
}

export * from './types';
