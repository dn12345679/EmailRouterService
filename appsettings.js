import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { RouterConfig } from './config/RouterConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ENV_FILE_PATH / CONFIG_FILE_PATH are set in main.js
dotenv.config({ path: process.env.ENV_FILE_PATH || path.join(__dirname, '.env') });

let userConfig;
if (process.env.CONFIG_FILE_PATH) {
  const overrides = (await import(pathToFileURL(process.env.CONFIG_FILE_PATH).href)).default;
  userConfig = Object.assign(new RouterConfig(), overrides).validate();
} else {
  userConfig = (await import('./config/config.js')).default;
}

export const SUBJECT_BUCKETS = userConfig.SUBJECT_BUCKETS;
export const CONDITION_BUCKETS = userConfig.CONDITION_BUCKETS;
export const REMINDER_CONFIG = userConfig.REMINDER_CONFIG;
export const ROUTING_CONFIG = userConfig.ROUTING_CONFIG;
export const REMOVE_SENDER_ON_ESCALATION = userConfig.REMOVE_SENDER_ON_ESCALATION;
export const NEEDS_INFO_CONFIG = userConfig.NEEDS_INFO_CONFIG;
export const UNCLASSIFIABLE_CONFIG = userConfig.UNCLASSIFIABLE_CONFIG;
export const ESCALATE_AFTER_REMINDERS_DEFAULT = userConfig.ESCALATE_AFTER_REMINDERS_DEFAULT;
export const DUPLICATE_SIMILARITY_THRESHOLD = userConfig.DUPLICATE_SIMILARITY_THRESHOLD;
export const CLASSIFICATION_EXAMPLE = userConfig.CLASSIFICATION_EXAMPLE;
export const CLASSIFICATION_PROMPT = userConfig.CLASSIFICATION_PROMPT;
export const CLOSING_MESSAGE = userConfig.CLOSING_MESSAGE;
export const DUPLICATE_CLOSING_MESSAGE = userConfig.DUPLICATE_CLOSING_MESSAGE;
export const THREAD_COMPLETE_MESSAGE = userConfig.THREAD_COMPLETE_MESSAGE;
export const REMINDER_MESSAGE = userConfig.REMINDER_MESSAGE;
export const NO_CODE_TOKEN = userConfig.NO_CODE_TOKEN;
export const NO_LOT_TOKEN = userConfig.NO_LOT_TOKEN;
export const MAX_PROPERTY_CODE_LEN = userConfig.MAX_PROPERTY_CODE_LEN;
export const UNCLASSIFIABLE_SUBJECT_LABEL = userConfig.UNCLASSIFIABLE_SUBJECT_LABEL;
export const IGNORED_SENDER_PATTERNS = userConfig.IGNORED_SENDER_PATTERNS;
export const SUPERVISORS_ROUTING_KEY = userConfig.SUPERVISORS_ROUTING_KEY;

const settings = {
  clientId: process.env.EML_CLIENT_ID,
  tenantId: process.env.EML_TENANT_ID,
  clientSecret: process.env.EML_CLIENT_SECRET,
  graphUserScopes: ['offline_access', 'user.read', 'mail.read', 'mail.send', 'mail.readwrite'],
  userEmail: process.env.userEmail,
};

export default settings;
