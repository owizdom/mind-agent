#!/usr/bin/env node

import { Command } from 'commander';
import { spawn, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getConfig, findConfigFile } from './utils/config';
import { logger } from './utils/logger';
import { getDb, closeDb } from './db/schema';
import { 
  getAllPendingIssues, 
  getStats, 
  getIssueById,
  getIssueByNumber,
  updateIssueStatus,
  DbIssue 
} from './db/queries';
import { 
  getRepoLocalPath, 
  pushBranch, 
  getDiff, 
  getStatus,
  hasUncommittedChanges,
  commitChanges 
} from './services/git-ops';
import { getTargetSummary } from './services/github';
import { runOnce, startDaemon } from './daemon';
import { runInit } from './init';

const program = new Command();

// PID file for daemon management
function getPidFile(): string {
  return path.join(os.homedir(), '.github-agent', 'daemon.pid');
}

function savePid(pid: number): void {
  const pidFile = getPidFile();
  const dir = path.dirname(pidFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(pidFile, pid.toString());
}

function readPid(): number | null {
  const pidFile = getPidFile();
  if (!fs.existsSync(pidFile)) {
    return null;
  }
  try {
    return parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
  } catch {
    return null;
  }
}

function removePid(): void {
  const pidFile = getPidFile();
  if (fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

program
  .name('github-agent')
  .description('Monitor GitHub organizations and repositories for issues, prepare context, and fix them')
  .version('1.0.0');

// Init command
program
  .command('init')
  .description('Initialize configuration with interactive setup wizard')
  .action(async () => {
    await runInit();
  });

// Start command
program
  .command('start')
  .description('Start the daemon in background')
  .option('-f, --foreground', 'Run in foreground instead of background')
  .action(async (options) => {
    // Check if config exists
    if (!findConfigFile()) {
      console.log('No configuration found. Run "github-agent init" to create one.');
      return;
    }

    const existingPid = readPid();
    if (existingPid && isProcessRunning(existingPid)) {
      console.log(`Daemon is already running (PID: ${existingPid})`);
      return;
    }

    if (options.foreground) {
      console.log('Starting daemon in foreground...');
      await startDaemon();
    } else {
      console.log('Starting daemon in background...');
      
      const daemonPath = path.join(__dirname, 'daemon.js');
      const config = getConfig();
      const logFile = path.join(config.dataDir, 'daemon.out.log');
      
      // Ensure log directory exists
      const logDir = path.dirname(logFile);
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }

      const out = fs.openSync(logFile, 'a');
      const err = fs.openSync(logFile, 'a');

      const child = spawn('node', [daemonPath], {
        detached: true,
        stdio: ['ignore', out, err],
        env: process.env,
        cwd: process.cwd(), // Important for finding config
      });

      child.unref();
      
      if (child.pid) {
        savePid(child.pid);
        console.log(`Daemon started (PID: ${child.pid})`);
        console.log(`Logs: ${logFile}`);
      }
    }
  });

// Stop command
program
  .command('stop')
  .description('Stop the daemon')
  .action(() => {
    const pid = readPid();
    if (!pid) {
      console.log('Daemon is not running');
      return;
    }

    if (!isProcessRunning(pid)) {
      console.log('Daemon process not found, cleaning up...');
      removePid();
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Stopped daemon (PID: ${pid})`);
      removePid();
    } catch (error) {
      console.error(`Failed to stop daemon: ${error}`);
    }
  });

// Status command
program
  .command('status')
  .description('Show queued issues and agent status')
  .action(() => {
    try {
      // Check if config exists
      const configPath = findConfigFile();
      
      // Check if daemon is running
      const pid = readPid();
      const daemonRunning = pid && isProcessRunning(pid);
      
      console.log('='.repeat(60));
      console.log('GITHUB ISSUE AGENT STATUS');
      console.log('='.repeat(60));
      console.log(`Daemon: ${daemonRunning ? `Running (PID: ${pid})` : 'Stopped'}`);
      console.log(`Config: ${configPath || 'Not found - run "github-agent init"'}`);
      console.log('');

      if (!configPath) {
        console.log('Run "github-agent init" to create a configuration.');
        return;
      }

      // Initialize DB to get stats
      const config = getConfig();
      
      console.log('TARGETS:');
      console.log(getTargetSummary().split('\n').map(l => `  ${l}`).join('\n'));
      console.log('');

      getDb();
      
      const stats = getStats();
      console.log('STATISTICS:');
      console.log(`  Total issues tracked: ${stats.totalIssues}`);
      console.log(`  New (unprocessed):    ${stats.newIssues || 0}`);
      console.log(`  Ready to fix:         ${stats.readyIssues || 0}`);
      console.log(`  Fixed (not pushed):   ${stats.fixedIssues || 0}`);
      console.log(`  Pushed:               ${stats.pushedIssues || 0}`);
      console.log('');

      const pendingIssues = getAllPendingIssues();
      
      if (pendingIssues.length === 0) {
        console.log('No pending issues.');
      } else {
        console.log('PENDING ISSUES:');
        console.log('-'.repeat(60));
        
        for (const issue of pendingIssues) {
          const statusIcon = issue.status === 'ready' ? '✓' : '○';
          console.log(`${statusIcon} [${issue.status.toUpperCase()}] ${issue.repo_name}#${issue.issue_number}`);
          console.log(`  ${issue.title}`);
          console.log(`  ${issue.html_url}`);
          if (issue.branch_name) {
            console.log(`  Branch: ${issue.branch_name}`);
          }
          console.log('');
        }
      }

      closeDb();
    } catch (error) {
      console.error(`Error: ${error}`);
    }
  });

// Scan command (run once)
program
  .command('scan')
  .description('Run a single scan immediately')
  .action(async () => {
    if (!findConfigFile()) {
      console.log('No configuration found. Run "github-agent init" to create one.');
      return;
    }

    console.log('Running scan...');
    try {
      await runOnce();
      console.log('Scan complete.');
    } catch (error) {
      console.error(`Scan failed: ${error}`);
    }
  });

// Open command
program
  .command('open <issue>')
  .description('Open an issue in your editor for fixing')
  .action(async (issueArg: string) => {
    if (!findConfigFile()) {
      console.log('No configuration found. Run "github-agent init" to create one.');
      return;
    }

    try {
      getDb();
      
      // Parse issue argument - could be just number or repo#number
      let issue: DbIssue | undefined;
      
      if (issueArg.includes('#')) {
        const [repo, num] = issueArg.split('#');
        issue = getIssueByNumber(repo, parseInt(num, 10));
      } else {
        // Try to find by issue number across all repos
        const allPending = getAllPendingIssues();
        issue = allPending.find(i => i.issue_number === parseInt(issueArg, 10));
      }

      if (!issue) {
        console.error(`Issue not found: ${issueArg}`);
        console.log('Run "github-agent status" to see available issues.');
        closeDb();
        return;
      }

      if (issue.status !== 'ready') {
        console.error(`Issue is not ready (status: ${issue.status})`);
        closeDb();
        return;
      }

      const repoPath = getRepoLocalPath(issue.repo_name);
      
      if (!fs.existsSync(repoPath)) {
        console.error(`Repository not cloned: ${repoPath}`);
        console.log('Run "github-agent scan" to clone repositories.');
        closeDb();
        return;
      }

      const config = getConfig();
      const editor = config.editor;
      
      console.log(`Opening ${issue.repo_name}#${issue.issue_number} in ${editor}...`);
      console.log(`Title: ${issue.title}`);
      console.log(`Branch: ${issue.branch_name}`);
      console.log('');

      // Open in configured editor
      exec(`${editor} "${repoPath}"`, (error) => {
        if (error) {
          console.log(`Could not open with "${editor}". Manual path: ${repoPath}`);
        }
      });

      // Show task file if exists
      if (issue.task_file_path && fs.existsSync(issue.task_file_path)) {
        console.log('Task file:');
        console.log(issue.task_file_path);
      }

      // Update status to in_progress
      updateIssueStatus(issue.id, 'in_progress');
      
      closeDb();
    } catch (error) {
      console.error(`Error: ${error}`);
      closeDb();
    }
  });

// Push command
program
  .command('push <issue>')
  .description('Push your fix after making changes')
  .option('-m, --message <message>', 'Custom commit message')
  .action(async (issueArg: string, options) => {
    if (!findConfigFile()) {
      console.log('No configuration found. Run "github-agent init" to create one.');
      return;
    }

    try {
      getDb();
      
      // Parse issue argument
      let issue: DbIssue | undefined;
      
      if (issueArg.includes('#')) {
        const [repo, num] = issueArg.split('#');
        issue = getIssueByNumber(repo, parseInt(num, 10));
      } else {
        const allPending = getAllPendingIssues();
        issue = allPending.find(i => i.issue_number === parseInt(issueArg, 10));
        
        // Also check in_progress issues
        if (!issue) {
          const inProgress = getAllPendingIssues();
          issue = inProgress.find(i => 
            i.issue_number === parseInt(issueArg, 10) && 
            (i.status === 'in_progress' || i.status === 'fixed')
          );
        }
      }

      if (!issue) {
        console.error(`Issue not found: ${issueArg}`);
        closeDb();
        return;
      }

      const repoPath = getRepoLocalPath(issue.repo_name);
      
      // Check for uncommitted changes
      const hasChanges = await hasUncommittedChanges(issue.repo_name);
      
      if (hasChanges) {
        console.log('Uncommitted changes found. Committing...');
        const commitMsg = options.message || 
          `fix: resolve issue #${issue.issue_number}\n\n${issue.title}\n\nCloses #${issue.issue_number}`;
        await commitChanges(issue.repo_name, commitMsg);
        console.log('Changes committed.');
      }

      // Show diff summary
      console.log('');
      console.log('Changes to push:');
      const status = await getStatus(issue.repo_name);
      console.log(`Branch: ${status.branch}`);
      console.log('');

      // Confirm push
      console.log('Pushing to origin...');
      await pushBranch(issue.repo_name);
      
      // Update status
      updateIssueStatus(issue.id, 'pushed');
      
      console.log('');
      console.log('✓ Successfully pushed!');
      console.log('');
      console.log('Next steps:');
      console.log(`1. Create a Pull Request: ${issue.html_url.replace('/issues/', '/compare/')}...${issue.branch_name}`);
      console.log('2. Request review');
      
      closeDb();
    } catch (error) {
      console.error(`Error: ${error}`);
      closeDb();
    }
  });

// Diff command
program
  .command('diff <issue>')
  .description('Show diff for an issue')
  .action(async (issueArg: string) => {
    if (!findConfigFile()) {
      console.log('No configuration found. Run "github-agent init" to create one.');
      return;
    }

    try {
      getDb();
      
      let issue: DbIssue | undefined;
      
      if (issueArg.includes('#')) {
        const [repo, num] = issueArg.split('#');
        issue = getIssueByNumber(repo, parseInt(num, 10));
      } else {
        const allPending = getAllPendingIssues();
        issue = allPending.find(i => i.issue_number === parseInt(issueArg, 10));
      }

      if (!issue) {
        console.error(`Issue not found: ${issueArg}`);
        closeDb();
        return;
      }

      const diff = await getDiff(issue.repo_name);
      console.log(diff || 'No changes');
      
      closeDb();
    } catch (error) {
      console.error(`Error: ${error}`);
      closeDb();
    }
  });

// Logs command
program
  .command('logs')
  .description('Show daemon logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action((options) => {
    const configPath = findConfigFile();
    if (!configPath) {
      console.log('No configuration found. Run "github-agent init" to create one.');
      return;
    }

    const config = getConfig();
    const logFile = config.logPath;

    if (!fs.existsSync(logFile)) {
      console.log('No logs found yet. Start the daemon with "github-agent start".');
      return;
    }

    if (options.follow) {
      const tail = spawn('tail', ['-f', logFile]);
      tail.stdout.pipe(process.stdout);
      tail.stderr.pipe(process.stderr);
    } else {
      const tail = spawn('tail', ['-n', options.lines, logFile]);
      tail.stdout.pipe(process.stdout);
      tail.stderr.pipe(process.stderr);
    }
  });

// Parse and execute
program.parse();
