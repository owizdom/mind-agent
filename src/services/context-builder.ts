import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { DbIssue, updateIssueTaskFile, updateIssueStatus } from '../db/queries';
import { getIssueDetails } from './github';

interface TaskContext {
  issue: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    repo_name: string;
    labels: string[];
  };
  comments: Array<{
    user: string;
    body: string;
    created_at: string;
  }>;
  relevantFiles: Array<{
    path: string;
    content: string;
    reason: string;
  }>;
  repoPath: string;
  branchName: string;
}

/**
 * Extract potential file references from issue text
 */
function extractFileReferences(text: string): string[] {
  const files: string[] = [];
  
  // Match common file patterns
  const patterns = [
    // File paths with extensions
    /(?:^|[\s`'"])([a-zA-Z0-9_\-./]+\.(ts|js|tsx|jsx|rs|py|go|md|json|yaml|yml|toml))/gm,
    // src/path/to/file patterns
    /(?:src|lib|packages?)\/[a-zA-Z0-9_\-./]+/g,
    // Function/class names that might be file names
    /(?:in|from|file|module)\s+[`']([a-zA-Z0-9_\-./]+)[`']/gi,
  ];

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);
    for (const match of matches) {
      const file = match[1] || match[0];
      if (file && !files.includes(file)) {
        files.push(file.replace(/^[`'"]+|[`'"]+$/g, ''));
      }
    }
  }

  return files;
}

/**
 * Extract keywords from issue text for searching
 */
function extractKeywords(text: string): string[] {
  // Common programming keywords to ignore
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'ought', 'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
    'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here',
    'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
    'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or',
    'because', 'until', 'while', 'this', 'that', 'these', 'those', 'it',
    'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they',
  ]);

  // Extract words that look like identifiers (camelCase, snake_case, etc.)
  const identifierPattern = /\b([A-Z][a-z]+[A-Z][a-zA-Z]*|[a-z]+_[a-z_]+|[A-Z][A-Z_]+)\b/g;
  const identifiers = [...text.matchAll(identifierPattern)].map(m => m[1]);

  // Extract other meaningful words
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3 && !stopWords.has(w));

  return [...new Set([...identifiers, ...words])];
}

/**
 * Find files in repo that might be relevant to the issue
 */
function findRelevantFiles(
  repoPath: string,
  fileRefs: string[],
  keywords: string[],
  maxFiles: number = 10
): Array<{ path: string; reason: string }> {
  const results: Array<{ path: string; reason: string; score: number }> = [];
  
  // Common directories to search
  const searchDirs = ['src', 'lib', 'packages', 'app', 'components', 'utils', 'services'];
  
  // File extensions to consider
  const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.rs', '.py', '.go', '.md']);

  function walkDir(dir: string, depth: number = 0): void {
    if (depth > 5) return; // Limit depth
    
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(repoPath, fullPath);

        // Skip node_modules, .git, etc.
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'dist') {
          continue;
        }

        if (entry.isDirectory()) {
          walkDir(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (!codeExtensions.has(ext)) continue;

          let score = 0;
          let reasons: string[] = [];

          // Check if file matches any reference
          for (const ref of fileRefs) {
            if (relativePath.includes(ref) || entry.name.includes(ref)) {
              score += 10;
              reasons.push(`Referenced in issue`);
              break;
            }
          }

          // Check if filename contains keywords
          const nameLower = entry.name.toLowerCase();
          for (const keyword of keywords.slice(0, 20)) { // Limit keywords checked
            if (nameLower.includes(keyword.toLowerCase())) {
              score += 3;
              reasons.push(`Matches keyword: ${keyword}`);
              break;
            }
          }

          // Prioritize certain files
          if (entry.name === 'README.md') {
            score += 2;
            reasons.push('README file');
          }
          if (entry.name.includes('index') || entry.name.includes('main') || entry.name.includes('lib')) {
            score += 1;
            reasons.push('Entry point file');
          }

          if (score > 0) {
            results.push({
              path: relativePath,
              reason: reasons[0] || 'Relevant file',
              score,
            });
          }
        }
      }
    } catch (error) {
      // Ignore permission errors etc.
    }
  }

  // Start walking from repo root
  walkDir(repoPath);

  // Sort by score and return top results
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles)
    .map(({ path: p, reason }) => ({ path: p, reason }));
}

/**
 * Read file content safely
 */
function readFileContent(filePath: string, maxLines: number = 500): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    
    if (lines.length > maxLines) {
      return lines.slice(0, maxLines).join('\n') + `\n\n... (truncated, ${lines.length - maxLines} more lines)`;
    }
    
    return content;
  } catch (error) {
    return `[Error reading file: ${error}]`;
  }
}

/**
 * Build context for an issue and save as a task file
 */
export async function buildContext(
  issue: DbIssue,
  repoPath: string,
  branchName: string
): Promise<string> {
  const config = getConfig();
  
  logger.info(`Building context for issue #${issue.issue_number} in ${issue.repo_name}`);

  // Fetch full issue details with comments
  const details = await getIssueDetails(issue.repo_name, issue.issue_number);
  
  const issueText = `${issue.title}\n${issue.body || ''}\n${
    details?.comments.map(c => c.body).join('\n') || ''
  }`;

  // Extract file references and keywords
  const fileRefs = extractFileReferences(issueText);
  const keywords = extractKeywords(issueText);

  logger.debug(`Found ${fileRefs.length} file references and ${keywords.length} keywords`);

  // Find relevant files
  const relevantFilePaths = findRelevantFiles(repoPath, fileRefs, keywords);
  
  // Read file contents
  const relevantFiles = relevantFilePaths.map(({ path: p, reason }) => ({
    path: p,
    content: readFileContent(path.join(repoPath, p)),
    reason,
  }));

  // Build task context
  const context: TaskContext = {
    issue: {
      number: issue.issue_number,
      title: issue.title,
      body: issue.body,
      html_url: issue.html_url,
      repo_name: issue.repo_name,
      labels: details?.issue.labels.map(l => l.name) || [],
    },
    comments: details?.comments || [],
    relevantFiles,
    repoPath,
    branchName,
  };

  // Generate task file content
  const taskContent = generateTaskFile(context);

  // Save task file
  const taskFileName = `${issue.repo_name}-${issue.issue_number}.md`;
  const taskFilePath = path.join(config.tasksDir, taskFileName);
  
  fs.writeFileSync(taskFilePath, taskContent, 'utf-8');
  
  // Update database
  updateIssueTaskFile(issue.id, taskFilePath);
  updateIssueStatus(issue.id, 'ready');

  logger.info(`Task file created: ${taskFilePath}`);

  return taskFilePath;
}

/**
 * Generate markdown task file content
 */
function generateTaskFile(context: TaskContext): string {
  const lines: string[] = [];

  lines.push(`# Issue #${context.issue.number}: ${context.issue.title}`);
  lines.push('');
  lines.push(`**Repository:** ${context.issue.repo_name}`);
  lines.push(`**Branch:** \`${context.branchName}\``);
  lines.push(`**GitHub URL:** ${context.issue.html_url}`);
  lines.push(`**Local Path:** \`${context.repoPath}\``);
  
  if (context.issue.labels.length > 0) {
    lines.push(`**Labels:** ${context.issue.labels.join(', ')}`);
  }
  
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Issue Description');
  lines.push('');
  lines.push(context.issue.body || '*No description provided*');
  lines.push('');

  if (context.comments.length > 0) {
    lines.push('## Comments');
    lines.push('');
    for (const comment of context.comments) {
      lines.push(`### @${comment.user} (${new Date(comment.created_at).toLocaleDateString()})`);
      lines.push('');
      lines.push(comment.body);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## Relevant Files');
  lines.push('');
  
  if (context.relevantFiles.length === 0) {
    lines.push('*No relevant files automatically identified. You may need to explore the repository.*');
  } else {
    for (const file of context.relevantFiles) {
      lines.push(`### \`${file.path}\``);
      lines.push(`*${file.reason}*`);
      lines.push('');
      lines.push('```');
      lines.push(file.content);
      lines.push('```');
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');
  lines.push('## How to Fix');
  lines.push('');
  lines.push('1. Open this repository in your editor:');
  lines.push(`   \`\`\`bash`);
  lines.push(`   github-agent open ${context.issue.number}`);
  lines.push(`   \`\`\``);
  lines.push('');
  lines.push('2. The branch has already been created: `' + context.branchName + '`');
  lines.push('');
  lines.push('3. Fix the issue described above');
  lines.push('');
  lines.push('4. After fixing, push your changes:');
  lines.push(`   \`\`\`bash`);
  lines.push(`   github-agent push ${context.issue.number}`);
  lines.push(`   \`\`\``);
  lines.push('');

  return lines.join('\n');
}
