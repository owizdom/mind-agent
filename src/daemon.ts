#!/usr/bin/env node

import { getConfig } from './utils/config';
import { logger } from './utils/logger';
import { getDb, closeDb } from './db/schema';
import { 
  getIssuesByStatus, 
  updateIssueStatus,
  DbIssue 
} from './db/queries';
import { scanAllRepos } from './services/github';
import { ensureRepoCloned, createIssueBranch, getRepoLocalPath } from './services/git-ops';
import { buildContext } from './services/context-builder';
import { 
  notifyMultipleNewIssues, 
  notifyIssueReady, 
  notifyScanComplete,
  notifyError 
} from './services/notifier';

let isRunning = false;
let scanInterval: NodeJS.Timeout | null = null;

/**
 * Process new issues - clone repos, create branches, build context
 */
async function processNewIssues(): Promise<void> {
  const newIssues = getIssuesByStatus('new');
  
  if (newIssues.length === 0) {
    logger.debug('No new issues to process');
    return;
  }

  logger.info(`Processing ${newIssues.length} new issues`);

  for (const issue of newIssues) {
    try {
      // Clone or update the repository
      logger.info(`Processing issue #${issue.issue_number} in ${issue.repo_name}`);
      const repoPath = await ensureRepoCloned(issue.repo_name);

      // Create a feature branch
      const branchName = await createIssueBranch(issue);

      // Build context and create task file
      await buildContext(issue, repoPath, branchName);

      // Notify that issue is ready
      notifyIssueReady(issue);

      logger.info(`Issue #${issue.issue_number} is ready for fixing`);
    } catch (error) {
      logger.error(`Failed to process issue #${issue.issue_number}: ${error}`);
      // Mark as skipped if there's an error
      updateIssueStatus(issue.id, 'skipped');
    }
  }
}

/**
 * Run a single scan cycle
 */
async function runScanCycle(): Promise<void> {
  logger.info('Starting scan cycle');

  try {
    // Scan all repos for issues
    const scanResult = await scanAllRepos();

    // Get newly discovered issues for notification
    const newIssues = getIssuesByStatus('new');
    
    if (newIssues.length > 0) {
      notifyMultipleNewIssues(newIssues);
    }

    // Process new issues
    await processNewIssues();

    // Notify scan complete if there were new issues
    notifyScanComplete(scanResult);

    logger.info('Scan cycle complete');
  } catch (error) {
    logger.error(`Scan cycle failed: ${error}`);
    notifyError(`Scan failed: ${error}`);
  }
}

/**
 * Start the daemon
 */
export async function startDaemon(): Promise<void> {
  if (isRunning) {
    logger.warn('Daemon is already running');
    return;
  }

  const config = getConfig();

  // Set up logging
  logger.setLogFile(config.logPath);
  logger.info('Starting GitHub Issue Agent daemon');
  
  const orgCount = config.targets.organizations.length;
  const repoCount = config.targets.repositories.length;
  logger.info(`Monitoring: ${orgCount} organization(s), ${repoCount} individual repo(s)`);
  logger.info(`Poll interval: ${config.scan.intervalMinutes} minutes`);

  // Initialize database
  getDb();

  isRunning = true;

  // Run initial scan
  await runScanCycle();

  // Set up interval for subsequent scans
  const intervalMs = config.scan.intervalMinutes * 60 * 1000;
  scanInterval = setInterval(async () => {
    if (isRunning) {
      await runScanCycle();
    }
  }, intervalMs);

  logger.info(`Daemon started. Next scan in ${config.scan.intervalMinutes} minutes.`);

  // Handle shutdown signals
  process.on('SIGINT', () => stopDaemon());
  process.on('SIGTERM', () => stopDaemon());
}

/**
 * Stop the daemon
 */
export function stopDaemon(): void {
  logger.info('Stopping GitHub Issue Agent daemon');
  
  isRunning = false;

  if (scanInterval) {
    clearInterval(scanInterval);
    scanInterval = null;
  }

  closeDb();
  
  logger.info('Daemon stopped');
  process.exit(0);
}

/**
 * Run a single scan (for CLI usage)
 */
export async function runOnce(): Promise<void> {
  const config = getConfig();
  logger.setLogFile(config.logPath);
  logger.info('Running single scan');

  getDb();

  try {
    await runScanCycle();
  } finally {
    closeDb();
  }
}

// If run directly (not imported)
if (require.main === module) {
  startDaemon().catch(error => {
    logger.error(`Failed to start daemon: ${error}`);
    process.exit(1);
  });
}
