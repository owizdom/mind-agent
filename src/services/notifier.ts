import notifier from 'node-notifier';
import * as path from 'path';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { DbIssue } from '../db/queries';

// Notification types
export type NotificationType = 'new_issue' | 'issue_ready' | 'scan_complete' | 'error';

interface NotificationOptions {
  title: string;
  message: string;
  type: NotificationType;
  issueId?: number;
  repoName?: string;
}

/**
 * Check if notifications are enabled for a specific type
 */
function shouldNotify(type: NotificationType): boolean {
  try {
    const config = getConfig();
    
    if (!config.notifications.enabled) {
      return false;
    }

    switch (type) {
      case 'new_issue':
      case 'issue_ready':
        return config.notifications.onNewIssue;
      case 'scan_complete':
        return config.notifications.onScanComplete;
      case 'error':
        return config.notifications.onError;
      default:
        return true;
    }
  } catch {
    // Config not loaded yet, allow notification
    return true;
  }
}

/**
 * Send a desktop notification
 */
export function notify(options: NotificationOptions): void {
  const { title, message, type } = options;

  if (!shouldNotify(type)) {
    logger.debug(`Notification skipped (disabled): ${title}`);
    return;
  }

  logger.debug(`Sending notification: ${title} - ${message}`);

  try {
    notifier.notify({
      title,
      message,
      sound: type === 'error' ? 'Basso' : 'default',
      timeout: 10,
      // macOS specific
      contentImage: undefined,
      // Actions would be nice but node-notifier has limited support
    });
  } catch (error) {
    logger.error(`Failed to send notification: ${error}`);
  }
}

/**
 * Notify about a new issue found
 */
export function notifyNewIssue(issue: DbIssue): void {
  notify({
    title: `New Issue in ${issue.repo_name}`,
    message: `#${issue.issue_number}: ${issue.title}`,
    type: 'new_issue',
    issueId: issue.id,
    repoName: issue.repo_name,
  });
}

/**
 * Notify that an issue is ready to be fixed
 */
export function notifyIssueReady(issue: DbIssue): void {
  notify({
    title: `Issue Ready to Fix`,
    message: `${issue.repo_name}#${issue.issue_number}: ${issue.title}\n\nRun: github-agent open ${issue.issue_number}`,
    type: 'issue_ready',
    issueId: issue.id,
    repoName: issue.repo_name,
  });
}

/**
 * Notify about scan completion
 */
export function notifyScanComplete(stats: {
  reposScanned: number;
  issuesFound: number;
  newIssues: number;
}): void {
  if (stats.newIssues > 0) {
    notify({
      title: `GitHub Agent Scan Complete`,
      message: `Found ${stats.newIssues} new issue${stats.newIssues > 1 ? 's' : ''} across ${stats.reposScanned} repos`,
      type: 'scan_complete',
    });
  }
}

/**
 * Notify about an error
 */
export function notifyError(message: string): void {
  notify({
    title: `GitHub Agent Error`,
    message,
    type: 'error',
  });
}

/**
 * Notify multiple new issues at once (batched)
 */
export function notifyMultipleNewIssues(issues: DbIssue[]): void {
  if (issues.length === 0) return;

  if (issues.length === 1) {
    notifyNewIssue(issues[0]);
    return;
  }

  // Group by repo
  const byRepo = new Map<string, DbIssue[]>();
  for (const issue of issues) {
    const existing = byRepo.get(issue.repo_name) || [];
    existing.push(issue);
    byRepo.set(issue.repo_name, existing);
  }

  if (byRepo.size === 1) {
    const [repoName, repoIssues] = [...byRepo.entries()][0];
    notify({
      title: `${repoIssues.length} New Issues in ${repoName}`,
      message: repoIssues.map(i => `#${i.issue_number}: ${i.title}`).slice(0, 3).join('\n') +
        (repoIssues.length > 3 ? `\n...and ${repoIssues.length - 3} more` : ''),
      type: 'new_issue',
    });
  } else {
    notify({
      title: `${issues.length} New Issues Found`,
      message: [...byRepo.entries()]
        .map(([repo, repoIssues]) => `${repo}: ${repoIssues.length} issue${repoIssues.length > 1 ? 's' : ''}`)
        .slice(0, 4)
        .join('\n'),
      type: 'new_issue',
    });
  }
}
