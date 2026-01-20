import { Octokit } from '@octokit/rest';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { 
  upsertIssue, 
  upsertRepository, 
  recordScan,
  GitHubIssueData 
} from '../db/queries';

let octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (!octokit) {
    const config = getConfig();
    octokit = new Octokit({
      auth: config.githubToken,
    });
  }
  return octokit;
}

export interface Repository {
  name: string;
  full_name: string;
  clone_url: string;
  html_url: string;
  description: string | null;
  has_issues: boolean;
  owner: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: Array<{ name: string }>;
}

/**
 * Fetch all repositories from an organization
 */
export async function fetchOrgRepos(orgName: string): Promise<Repository[]> {
  const client = getOctokit();
  const repos: Repository[] = [];

  logger.info(`Fetching repositories from organization: ${orgName}`);

  try {
    for await (const response of client.paginate.iterator(
      client.repos.listForOrg,
      {
        org: orgName,
        type: 'all',
        per_page: 100,
      }
    )) {
      for (const repo of response.data) {
        repos.push({
          name: repo.name,
          full_name: repo.full_name,
          clone_url: repo.clone_url || `https://github.com/${repo.full_name}.git`,
          html_url: repo.html_url || `https://github.com/${repo.full_name}`,
          description: repo.description ?? null,
          has_issues: repo.has_issues ?? true,
          owner: orgName,
        });

        // Store in database
        upsertRepository({
          name: repo.name,
          full_name: repo.full_name,
          clone_url: repo.clone_url || `https://github.com/${repo.full_name}.git`,
        });
      }
    }

    logger.info(`Found ${repos.length} repositories in ${orgName}`);
    return repos;
  } catch (error) {
    logger.error(`Failed to fetch repositories from ${orgName}`, { error: String(error) });
    throw error;
  }
}

/**
 * Fetch a single repository by owner/repo
 */
export async function fetchRepo(owner: string, repo: string): Promise<Repository | null> {
  const client = getOctokit();

  logger.info(`Fetching repository: ${owner}/${repo}`);

  try {
    const { data } = await client.repos.get({
      owner,
      repo,
    });

    const repository: Repository = {
      name: data.name,
      full_name: data.full_name,
      clone_url: data.clone_url || `https://github.com/${data.full_name}.git`,
      html_url: data.html_url || `https://github.com/${data.full_name}`,
      description: data.description ?? null,
      has_issues: data.has_issues ?? true,
      owner,
    };

    // Store in database
    upsertRepository({
      name: data.name,
      full_name: data.full_name,
      clone_url: data.clone_url || `https://github.com/${data.full_name}.git`,
    });

    return repository;
  } catch (error) {
    logger.error(`Failed to fetch repository ${owner}/${repo}`, { error: String(error) });
    return null;
  }
}

/**
 * Fetch open issues from a repository with optional filters
 */
export async function fetchRepoIssues(
  owner: string, 
  repoName: string,
  filters?: { state?: 'open' | 'closed' | 'all'; labels?: string[] }
): Promise<Issue[]> {
  const client = getOctokit();
  const issues: Issue[] = [];
  const config = getConfig();

  // Use config filters if not provided
  const state = filters?.state || config.scan.filters.state;
  const labels = filters?.labels || config.scan.filters.labels;

  try {
    const options: Parameters<typeof client.issues.listForRepo>[0] = {
      owner,
      repo: repoName,
      state,
      per_page: 100,
    };

    // Add labels filter if specified
    if (labels.length > 0) {
      options.labels = labels.join(',');
    }

    for await (const response of client.paginate.iterator(
      client.issues.listForRepo,
      options
    )) {
      for (const issue of response.data) {
        // Skip pull requests (they show up in issues API too)
        if (issue.pull_request) {
          continue;
        }

        issues.push({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body ?? null,
          state: issue.state,
          html_url: issue.html_url,
          created_at: issue.created_at,
          updated_at: issue.updated_at,
          labels: issue.labels
            .filter((l): l is { name: string } => typeof l === 'object' && l !== null && 'name' in l)
            .map(l => ({ name: l.name })),
        });
      }
    }

    return issues;
  } catch (error) {
    logger.warn(`Failed to fetch issues for ${owner}/${repoName}`, { error: String(error) });
    return [];
  }
}

/**
 * Fetch all repositories from all configured targets
 */
export async function fetchAllTargetRepos(): Promise<Repository[]> {
  const config = getConfig();
  const allRepos: Repository[] = [];

  // Fetch repos from organizations
  for (const org of config.targets.organizations) {
    try {
      const repos = await fetchOrgRepos(org);
      allRepos.push(...repos);
    } catch (error) {
      logger.error(`Failed to fetch org ${org}, skipping...`);
    }
  }

  // Fetch individual repositories
  for (const { owner, repo } of config.targets.repositories) {
    try {
      const repository = await fetchRepo(owner, repo);
      if (repository) {
        // Check if we already have this repo from an org
        const exists = allRepos.some(r => r.full_name === repository.full_name);
        if (!exists) {
          allRepos.push(repository);
        }
      }
    } catch (error) {
      logger.error(`Failed to fetch repo ${owner}/${repo}, skipping...`);
    }
  }

  logger.info(`Total repositories to monitor: ${allRepos.length}`);
  return allRepos;
}

/**
 * Scan all configured targets for issues and store them in the database
 */
export async function scanAllRepos(): Promise<{
  reposScanned: number;
  issuesFound: number;
  newIssues: number;
}> {
  logger.info('Starting full repository scan');

  const repos = await fetchAllTargetRepos();
  let totalIssues = 0;
  let newIssuesCount = 0;

  // Only scan repos that have issues enabled
  const reposWithIssues = repos.filter(r => r.has_issues);
  logger.info(`Scanning ${reposWithIssues.length} repositories with issues enabled`);

  for (const repo of reposWithIssues) {
    logger.debug(`Scanning ${repo.full_name} for issues`);
    const issues = await fetchRepoIssues(repo.owner, repo.name);
    totalIssues += issues.length;

    for (const issue of issues) {
      const issueData: GitHubIssueData = {
        github_id: issue.id,
        repo_name: repo.name,
        issue_number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        html_url: issue.html_url,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
      };

      const { isNew } = upsertIssue(issueData);
      if (isNew) {
        newIssuesCount++;
        logger.info(`New issue found: ${repo.full_name}#${issue.number} - ${issue.title}`);
      }
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Record this scan
  recordScan(reposWithIssues.length, totalIssues, newIssuesCount);

  logger.info(`Scan complete: ${reposWithIssues.length} repos, ${totalIssues} issues, ${newIssuesCount} new`);

  return {
    reposScanned: reposWithIssues.length,
    issuesFound: totalIssues,
    newIssues: newIssuesCount,
  };
}

/**
 * Get issue details including comments
 */
export async function getIssueDetails(repoFullName: string, issueNumber: number): Promise<{
  issue: Issue;
  comments: Array<{ body: string; user: string; created_at: string }>;
} | null> {
  const client = getOctokit();

  // Parse owner/repo from full name
  const [owner, repo] = repoFullName.includes('/') 
    ? repoFullName.split('/')
    : [getConfig().targets.organizations[0], repoFullName];

  try {
    const { data: issue } = await client.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });

    const { data: comments } = await client.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
    });

    return {
      issue: {
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        state: issue.state,
        html_url: issue.html_url,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        labels: issue.labels
          .filter((l): l is { name: string } => typeof l === 'object' && l !== null && 'name' in l)
          .map(l => ({ name: l.name })),
      },
      comments: comments.map(c => ({
        body: c.body || '',
        user: c.user?.login || 'unknown',
        created_at: c.created_at,
      })),
    };
  } catch (error) {
    logger.error(`Failed to get issue details for ${repoFullName}#${issueNumber}`, { error: String(error) });
    return null;
  }
}

/**
 * Get target summary for display
 */
export function getTargetSummary(): string {
  const config = getConfig();
  const parts: string[] = [];

  if (config.targets.organizations.length > 0) {
    parts.push(`Organizations: ${config.targets.organizations.join(', ')}`);
  }

  if (config.targets.repositories.length > 0) {
    const repos = config.targets.repositories.map(r => `${r.owner}/${r.repo}`);
    parts.push(`Repositories: ${repos.join(', ')}`);
  }

  return parts.join('\n');
}
