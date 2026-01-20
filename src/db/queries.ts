import { getDb } from './schema';

// Issue status types
export type IssueStatus = 'new' | 'ready' | 'in_progress' | 'fixed' | 'pushed' | 'skipped';

export interface DbIssue {
  id: number;
  github_id: number;
  repo_name: string;
  issue_number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  first_seen_at: string;
  status: IssueStatus;
  branch_name: string | null;
  task_file_path: string | null;
}

export interface DbRepository {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  local_path: string | null;
  last_cloned_at: string | null;
  last_updated_at: string | null;
}

export interface GitHubIssueData {
  github_id: number;
  repo_name: string;
  issue_number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

// Issue queries
export function upsertIssue(issue: GitHubIssueData): { isNew: boolean; id: number } {
  const db = getDb();
  
  // Check if issue exists
  const existing = db.prepare(`
    SELECT id, updated_at FROM issues WHERE github_id = ?
  `).get(issue.github_id) as { id: number; updated_at: string } | undefined;

  if (existing) {
    // Update existing issue
    db.prepare(`
      UPDATE issues SET
        title = ?,
        body = ?,
        state = ?,
        updated_at = ?
      WHERE github_id = ?
    `).run(issue.title, issue.body, issue.state, issue.updated_at, issue.github_id);
    
    return { isNew: false, id: existing.id };
  } else {
    // Insert new issue
    const result = db.prepare(`
      INSERT INTO issues (github_id, repo_name, issue_number, title, body, state, html_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      issue.github_id,
      issue.repo_name,
      issue.issue_number,
      issue.title,
      issue.body,
      issue.state,
      issue.html_url,
      issue.created_at,
      issue.updated_at
    );
    
    return { isNew: true, id: result.lastInsertRowid as number };
  }
}

export function getIssuesByStatus(status: IssueStatus): DbIssue[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM issues WHERE status = ? ORDER BY first_seen_at DESC
  `).all(status) as DbIssue[];
}

export function getIssueByNumber(repoName: string, issueNumber: number): DbIssue | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM issues WHERE repo_name = ? AND issue_number = ?
  `).get(repoName, issueNumber) as DbIssue | undefined;
}

export function getIssueById(id: number): DbIssue | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM issues WHERE id = ?').get(id) as DbIssue | undefined;
}

export function getAllPendingIssues(): DbIssue[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM issues 
    WHERE status IN ('new', 'ready') 
    ORDER BY first_seen_at DESC
  `).all() as DbIssue[];
}

export function updateIssueStatus(id: number, status: IssueStatus): void {
  const db = getDb();
  db.prepare('UPDATE issues SET status = ? WHERE id = ?').run(status, id);
}

export function updateIssueBranch(id: number, branchName: string): void {
  const db = getDb();
  db.prepare('UPDATE issues SET branch_name = ? WHERE id = ?').run(branchName, id);
}

export function updateIssueTaskFile(id: number, taskFilePath: string): void {
  const db = getDb();
  db.prepare('UPDATE issues SET task_file_path = ? WHERE id = ?').run(taskFilePath, id);
}

// Repository queries
export function upsertRepository(repo: {
  name: string;
  full_name: string;
  clone_url: string;
}): number {
  const db = getDb();
  
  const existing = db.prepare('SELECT id FROM repositories WHERE name = ?').get(repo.name) as { id: number } | undefined;
  
  if (existing) {
    db.prepare(`
      UPDATE repositories SET full_name = ?, clone_url = ?, last_updated_at = datetime('now')
      WHERE name = ?
    `).run(repo.full_name, repo.clone_url, repo.name);
    return existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO repositories (name, full_name, clone_url)
      VALUES (?, ?, ?)
    `).run(repo.name, repo.full_name, repo.clone_url);
    return result.lastInsertRowid as number;
  }
}

export function getRepository(name: string): DbRepository | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM repositories WHERE name = ?').get(name) as DbRepository | undefined;
}

export function updateRepositoryLocalPath(name: string, localPath: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE repositories SET local_path = ?, last_cloned_at = datetime('now')
    WHERE name = ?
  `).run(localPath, name);
}

// Scan history queries
export function recordScan(reposScanned: number, issuesFound: number, newIssues: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO scan_history (repos_scanned, issues_found, new_issues)
    VALUES (?, ?, ?)
  `).run(reposScanned, issuesFound, newIssues);
}

export function getLastScan(): { scanned_at: string; repos_scanned: number; issues_found: number; new_issues: number } | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM scan_history ORDER BY scanned_at DESC LIMIT 1
  `).get() as { scanned_at: string; repos_scanned: number; issues_found: number; new_issues: number } | undefined;
}

// Stats
export function getStats(): {
  totalIssues: number;
  newIssues: number;
  readyIssues: number;
  fixedIssues: number;
  pushedIssues: number;
} {
  const db = getDb();
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as totalIssues,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as newIssues,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as readyIssues,
      SUM(CASE WHEN status = 'fixed' THEN 1 ELSE 0 END) as fixedIssues,
      SUM(CASE WHEN status = 'pushed' THEN 1 ELSE 0 END) as pushedIssues
    FROM issues
  `).get() as {
    totalIssues: number;
    newIssues: number;
    readyIssues: number;
    fixedIssues: number;
    pushedIssues: number;
  };
  
  return stats;
}
