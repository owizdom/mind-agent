import simpleGit, { SimpleGit, CloneOptions } from 'simple-git';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { 
  getRepository, 
  updateRepositoryLocalPath, 
  updateIssueBranch,
  DbIssue 
} from '../db/queries';

/**
 * Get the local path for a repository
 */
export function getRepoLocalPath(repoName: string): string {
  const config = getConfig();
  return path.join(config.reposDir, repoName);
}

/**
 * Check if a repository is cloned locally
 */
export function isRepoCloned(repoName: string): boolean {
  const localPath = getRepoLocalPath(repoName);
  return fs.existsSync(path.join(localPath, '.git'));
}

/**
 * Clone a repository
 */
export async function cloneRepo(repoName: string): Promise<string> {
  const config = getConfig();
  const localPath = getRepoLocalPath(repoName);

  // Get repo info from database
  const repo = getRepository(repoName);
  if (!repo) {
    throw new Error(`Repository ${repoName} not found in database. Run a scan first.`);
  }

  logger.info(`Cloning ${repoName} to ${localPath}`);

  // Create parent directory if needed
  const parentDir = path.dirname(localPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  // Clone with auth token
  const cloneUrl = repo.clone_url.replace(
    'https://',
    `https://${config.githubToken}@`
  );

  const git = simpleGit();
  const options: CloneOptions = {
    '--depth': 1, // Shallow clone for speed
  };

  await git.clone(cloneUrl, localPath, options);

  // Update database
  updateRepositoryLocalPath(repoName, localPath);

  logger.info(`Successfully cloned ${repoName}`);
  return localPath;
}

/**
 * Ensure a repository is cloned and up to date
 */
export async function ensureRepoCloned(repoName: string): Promise<string> {
  const localPath = getRepoLocalPath(repoName);

  if (isRepoCloned(repoName)) {
    logger.debug(`Repository ${repoName} already cloned, pulling latest`);
    await pullRepo(repoName);
    return localPath;
  }

  return await cloneRepo(repoName);
}

/**
 * Pull latest changes for a repository
 */
export async function pullRepo(repoName: string): Promise<void> {
  const localPath = getRepoLocalPath(repoName);

  if (!isRepoCloned(repoName)) {
    throw new Error(`Repository ${repoName} is not cloned`);
  }

  const git: SimpleGit = simpleGit(localPath);

  try {
    // Fetch and reset to origin/main (or master)
    await git.fetch(['origin']);
    
    // Try to determine default branch
    const branches = await git.branch(['-r']);
    const defaultBranch = branches.all.find(b => 
      b.includes('origin/main') || b.includes('origin/master')
    )?.replace('origin/', '') || 'main';

    // Checkout and reset to default branch
    await git.checkout(defaultBranch);
    await git.reset(['--hard', `origin/${defaultBranch}`]);

    logger.debug(`Updated ${repoName} to latest`);
  } catch (error) {
    logger.warn(`Failed to pull ${repoName}: ${error}`);
    // Don't throw - repo might still be usable
  }
}

/**
 * Create a feature branch for an issue
 */
export async function createIssueBranch(issue: DbIssue): Promise<string> {
  const localPath = getRepoLocalPath(issue.repo_name);

  if (!isRepoCloned(issue.repo_name)) {
    throw new Error(`Repository ${issue.repo_name} is not cloned`);
  }

  // Generate branch name
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  
  const branchName = `fix/issue-${issue.issue_number}-${slug}`;

  const git: SimpleGit = simpleGit(localPath);

  try {
    // Check if branch already exists
    const branches = await git.branchLocal();
    if (branches.all.includes(branchName)) {
      logger.info(`Branch ${branchName} already exists, checking out`);
      await git.checkout(branchName);
    } else {
      // Create and checkout new branch
      await git.checkoutLocalBranch(branchName);
      logger.info(`Created branch ${branchName}`);
    }

    // Update database
    updateIssueBranch(issue.id, branchName);

    return branchName;
  } catch (error) {
    logger.error(`Failed to create branch for issue #${issue.issue_number}: ${error}`);
    throw error;
  }
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(repoName: string): Promise<string> {
  const localPath = getRepoLocalPath(repoName);
  const git: SimpleGit = simpleGit(localPath);
  
  const status = await git.status();
  return status.current || 'unknown';
}

/**
 * Check if there are uncommitted changes
 */
export async function hasUncommittedChanges(repoName: string): Promise<boolean> {
  const localPath = getRepoLocalPath(repoName);
  const git: SimpleGit = simpleGit(localPath);
  
  const status = await git.status();
  return !status.isClean();
}

/**
 * Commit all changes
 */
export async function commitChanges(
  repoName: string, 
  message: string
): Promise<string> {
  const localPath = getRepoLocalPath(repoName);
  const git: SimpleGit = simpleGit(localPath);

  // Stage all changes
  await git.add('-A');

  // Commit
  const result = await git.commit(message);
  
  logger.info(`Committed changes to ${repoName}: ${result.commit}`);
  return result.commit;
}

/**
 * Push the current branch to origin
 */
export async function pushBranch(repoName: string): Promise<void> {
  const localPath = getRepoLocalPath(repoName);
  const config = getConfig();
  const git: SimpleGit = simpleGit(localPath);

  const currentBranch = await getCurrentBranch(repoName);

  // Set remote URL with token for authentication
  const repo = getRepository(repoName);
  if (repo) {
    const authUrl = repo.clone_url.replace(
      'https://',
      `https://${config.githubToken}@`
    );
    await git.remote(['set-url', 'origin', authUrl]);
  }

  logger.info(`Pushing ${currentBranch} to origin`);
  await git.push(['--set-upstream', 'origin', currentBranch]);
  logger.info(`Successfully pushed ${currentBranch}`);
}

/**
 * Get diff of current changes
 */
export async function getDiff(repoName: string): Promise<string> {
  const localPath = getRepoLocalPath(repoName);
  const git: SimpleGit = simpleGit(localPath);

  // Get diff of staged and unstaged changes
  const diffSummary = await git.diff(['--stat']);
  const diffFull = await git.diff();

  return `${diffSummary}\n\n${diffFull}`;
}

/**
 * Get status summary
 */
export async function getStatus(repoName: string): Promise<{
  branch: string;
  isClean: boolean;
  modified: string[];
  added: string[];
  deleted: string[];
}> {
  const localPath = getRepoLocalPath(repoName);
  const git: SimpleGit = simpleGit(localPath);

  const status = await git.status();

  return {
    branch: status.current || 'unknown',
    isClean: status.isClean(),
    modified: status.modified,
    added: status.created,
    deleted: status.deleted,
  };
}
