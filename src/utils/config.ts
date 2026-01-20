import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import * as dotenv from 'dotenv';

// Load .env file if it exists
dotenv.config();

// Config file names to search for
const CONFIG_FILE_NAMES = [
  'github-agent.yaml',
  'github-agent.yml',
  '.github-agent.yaml',
  '.github-agent.yml',
];

export interface TargetsConfig {
  organizations: string[];
  repositories: string[]; // format: owner/repo
}

export interface ScanFilters {
  state: 'open' | 'closed' | 'all';
  labels: string[];
}

export interface ScanConfig {
  interval_minutes: number;
  filters: ScanFilters;
}

export interface PathsConfig {
  repos_dir: string;
  data_dir: string;
}

export interface NotificationsConfig {
  enabled: boolean;
  on_new_issue: boolean;
  on_scan_complete: boolean;
  on_error: boolean;
}

export interface ConfigFile {
  github_token: string;
  targets: TargetsConfig;
  scan: ScanConfig;
  paths: PathsConfig;
  notifications: NotificationsConfig;
}

export interface Config {
  githubToken: string;
  targets: {
    organizations: string[];
    repositories: Array<{ owner: string; repo: string }>;
  };
  scan: {
    intervalMinutes: number;
    filters: {
      state: 'open' | 'closed' | 'all';
      labels: string[];
    };
  };
  reposDir: string;
  dataDir: string;
  dbPath: string;
  logPath: string;
  tasksDir: string;
  notifications: {
    enabled: boolean;
    onNewIssue: boolean;
    onScanComplete: boolean;
    onError: boolean;
  };
  configPath: string;
}

/**
 * Expand ~ to home directory and resolve path
 */
function expandPath(filepath: string): string {
  if (filepath.startsWith('~')) {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return path.resolve(filepath);
}

/**
 * Ensure directory exists
 */
function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Replace ${VAR} with environment variable values
 */
function expandEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    return process.env[varName] || '';
  });
}

/**
 * Find config file in current directory or parent directories
 */
export function findConfigFile(startDir: string = process.cwd()): string | null {
  let currentDir = startDir;
  
  while (currentDir !== path.dirname(currentDir)) {
    for (const filename of CONFIG_FILE_NAMES) {
      const configPath = path.join(currentDir, filename);
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }
    currentDir = path.dirname(currentDir);
  }
  
  // Also check home directory
  for (const filename of CONFIG_FILE_NAMES) {
    const configPath = path.join(os.homedir(), filename);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }
  
  return null;
}

/**
 * Load and parse config file
 */
export function loadConfigFile(configPath: string): ConfigFile {
  const content = fs.readFileSync(configPath, 'utf-8');
  const parsed = yaml.load(content) as ConfigFile;
  
  // Expand environment variables in github_token
  if (parsed.github_token) {
    parsed.github_token = expandEnvVars(parsed.github_token);
  }
  
  return parsed;
}

/**
 * Get default config values
 */
function getDefaultConfig(): Partial<ConfigFile> {
  return {
    targets: {
      organizations: [],
      repositories: [],
    },
    scan: {
      interval_minutes: 5,
      filters: {
        state: 'open',
        labels: [],
      },
    },
    paths: {
      repos_dir: '~/.github-agent/repos',
      data_dir: '~/.github-agent/data',
    },
    notifications: {
      enabled: true,
      on_new_issue: true,
      on_scan_complete: false,
      on_error: true,
    },
  };
}

/**
 * Parse repository string (owner/repo) into object
 */
function parseRepoString(repoStr: string): { owner: string; repo: string } {
  const parts = repoStr.split('/');
  if (parts.length !== 2) {
    throw new Error(`Invalid repository format: ${repoStr}. Expected: owner/repo`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Load configuration from file and environment
 */
function loadConfig(): Config {
  const configPath = findConfigFile();
  
  let fileConfig: Partial<ConfigFile> = {};
  let resolvedConfigPath = '';
  
  if (configPath) {
    fileConfig = loadConfigFile(configPath);
    resolvedConfigPath = configPath;
  }
  
  const defaults = getDefaultConfig();
  
  // Merge with defaults
  const merged: ConfigFile = {
    github_token: fileConfig.github_token || process.env.GITHUB_TOKEN || '',
    targets: {
      organizations: fileConfig.targets?.organizations || defaults.targets!.organizations,
      repositories: fileConfig.targets?.repositories || defaults.targets!.repositories,
    },
    scan: {
      interval_minutes: fileConfig.scan?.interval_minutes ?? defaults.scan!.interval_minutes,
      filters: {
        state: fileConfig.scan?.filters?.state || defaults.scan!.filters.state,
        labels: fileConfig.scan?.filters?.labels || defaults.scan!.filters.labels,
      },
    },
    paths: {
      repos_dir: fileConfig.paths?.repos_dir || defaults.paths!.repos_dir,
      data_dir: fileConfig.paths?.data_dir || defaults.paths!.data_dir,
    },
    notifications: {
      enabled: fileConfig.notifications?.enabled ?? defaults.notifications!.enabled,
      on_new_issue: fileConfig.notifications?.on_new_issue ?? defaults.notifications!.on_new_issue,
      on_scan_complete: fileConfig.notifications?.on_scan_complete ?? defaults.notifications!.on_scan_complete,
      on_error: fileConfig.notifications?.on_error ?? defaults.notifications!.on_error,
    },
  };
  
  // Validate required fields
  if (!merged.github_token) {
    throw new Error(
      'GitHub token is required.\n\n' +
      'Options:\n' +
      '1. Run "github-agent init" to create a config file\n' +
      '2. Set GITHUB_TOKEN environment variable\n' +
      '3. Add github_token to github-agent.yaml'
    );
  }
  
  if (merged.targets.organizations.length === 0 && merged.targets.repositories.length === 0) {
    throw new Error(
      'No targets configured.\n\n' +
      'Add organizations or repositories to monitor in github-agent.yaml:\n\n' +
      'targets:\n' +
      '  organizations:\n' +
      '    - your-org\n' +
      '  repositories:\n' +
      '    - owner/repo'
    );
  }
  
  // Expand and ensure paths
  const reposDir = expandPath(merged.paths.repos_dir);
  const dataDir = expandPath(merged.paths.data_dir);
  const tasksDir = path.join(dataDir, 'tasks');
  
  ensureDir(reposDir);
  ensureDir(dataDir);
  ensureDir(tasksDir);
  
  // Parse repository strings
  const repositories = merged.targets.repositories.map(parseRepoString);
  
  return {
    githubToken: merged.github_token,
    targets: {
      organizations: merged.targets.organizations,
      repositories,
    },
    scan: {
      intervalMinutes: merged.scan.interval_minutes,
      filters: {
        state: merged.scan.filters.state,
        labels: merged.scan.filters.labels,
      },
    },
    reposDir,
    dataDir,
    dbPath: path.join(dataDir, 'github-agent.db'),
    logPath: path.join(dataDir, 'github-agent.log'),
    tasksDir,
    notifications: {
      enabled: merged.notifications.enabled,
      onNewIssue: merged.notifications.on_new_issue,
      onScanComplete: merged.notifications.on_scan_complete,
      onError: merged.notifications.on_error,
    },
    configPath: resolvedConfigPath,
  };
}

// Singleton config instance
let configInstance: Config | null = null;

export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

// For testing purposes - allows resetting config
export function resetConfig(): void {
  configInstance = null;
}

/**
 * Check if config file exists (for init command)
 */
export function configFileExists(): boolean {
  return findConfigFile() !== null;
}

/**
 * Get the default config file path for creating new config
 */
export function getDefaultConfigPath(): string {
  return path.join(process.cwd(), 'github-agent.yaml');
}
