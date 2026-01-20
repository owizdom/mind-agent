import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import inquirer from 'inquirer';
import { configFileExists, getDefaultConfigPath } from './utils/config';
import { logger } from './utils/logger';

interface InitAnswers {
  githubToken: string;
  targetType: 'organization' | 'repository' | 'both';
  organizations: string;
  repositories: string;
  scanInterval: number;
  issueState: 'open' | 'closed' | 'all';
  labels: string;
  enableNotifications: boolean;
}

/**
 * Interactive setup wizard for github-agent
 */
export async function runInit(): Promise<void> {
  console.log('\n🚀 GitHub Issue Agent Setup\n');
  console.log('This wizard will help you create a configuration file.\n');

  // Check if config already exists
  if (configFileExists()) {
    const { overwrite } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'overwrite',
        message: 'A configuration file already exists. Overwrite it?',
        default: false,
      },
    ]);

    if (!overwrite) {
      console.log('\nSetup cancelled. Existing config preserved.');
      return;
    }
  }

  // Gather configuration
  const answers = await inquirer.prompt<InitAnswers>([
    {
      type: 'password',
      name: 'githubToken',
      message: 'GitHub Personal Access Token:',
      mask: '*',
      validate: (input: string) => {
        if (!input || input.length < 10) {
          return 'Please enter a valid GitHub token. Create one at: https://github.com/settings/tokens';
        }
        return true;
      },
    },
    {
      type: 'list',
      name: 'targetType',
      message: 'What do you want to monitor?',
      choices: [
        { name: 'GitHub Organization(s)', value: 'organization' },
        { name: 'Specific Repository(ies)', value: 'repository' },
        { name: 'Both organizations and specific repos', value: 'both' },
      ],
    },
    {
      type: 'input',
      name: 'organizations',
      message: 'Organization name(s) (comma-separated):',
      when: (answers) => answers.targetType === 'organization' || answers.targetType === 'both',
      validate: (input: string) => {
        if (!input.trim()) {
          return 'Please enter at least one organization name';
        }
        return true;
      },
    },
    {
      type: 'input',
      name: 'repositories',
      message: 'Repository(ies) in owner/repo format (comma-separated):',
      when: (answers) => answers.targetType === 'repository' || answers.targetType === 'both',
      validate: (input: string, answers) => {
        if (answers?.targetType === 'repository' && !input.trim()) {
          return 'Please enter at least one repository';
        }
        const repos = input.split(',').map(r => r.trim()).filter(Boolean);
        for (const repo of repos) {
          if (!repo.includes('/')) {
            return `Invalid format: "${repo}". Use owner/repo format`;
          }
        }
        return true;
      },
    },
    {
      type: 'number',
      name: 'scanInterval',
      message: 'Scan interval (minutes):',
      default: 5,
      validate: (input: number) => {
        if (input < 1) return 'Interval must be at least 1 minute';
        if (input > 60) return 'Interval should be 60 minutes or less';
        return true;
      },
    },
    {
      type: 'list',
      name: 'issueState',
      message: 'Which issues to monitor?',
      choices: [
        { name: 'Open issues only', value: 'open' },
        { name: 'Closed issues only', value: 'closed' },
        { name: 'All issues', value: 'all' },
      ],
      default: 'open',
    },
    {
      type: 'input',
      name: 'labels',
      message: 'Filter by labels (comma-separated, leave empty for all):',
      default: '',
    },
    {
      type: 'confirm',
      name: 'enableNotifications',
      message: 'Enable desktop notifications?',
      default: true,
    },
  ]);

  // Build config object
  const config = buildConfig(answers);

  // Generate YAML
  const yamlContent = generateYaml(config);

  // Determine output path
  const configPath = getDefaultConfigPath();

  // Write config file
  fs.writeFileSync(configPath, yamlContent, 'utf-8');
  console.log(`\n✅ Configuration saved to: ${configPath}`);

  // Create .env file for token if desired
  const { createEnvFile } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'createEnvFile',
      message: 'Save GitHub token to .env file? (recommended for security)',
      default: true,
    },
  ]);

  if (createEnvFile) {
    const envPath = path.join(path.dirname(configPath), '.env');
    const envContent = `# GitHub Personal Access Token\nGITHUB_TOKEN=${answers.githubToken}\n`;
    fs.writeFileSync(envPath, envContent, 'utf-8');
    console.log(`✅ Token saved to: ${envPath}`);

    // Update config to use env var
    const updatedYaml = yamlContent.replace(
      `github_token: "${answers.githubToken}"`,
      'github_token: ${GITHUB_TOKEN}'
    );
    fs.writeFileSync(configPath, updatedYaml, 'utf-8');
    
    // Add .env to .gitignore if it exists
    const gitignorePath = path.join(path.dirname(configPath), '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
      if (!gitignore.includes('.env')) {
        fs.appendFileSync(gitignorePath, '\n.env\n');
        console.log('✅ Added .env to .gitignore');
      }
    }
  }

  console.log('\n🎉 Setup complete!\n');
  console.log('Next steps:');
  console.log('  1. Run: github-agent scan     # Test the configuration');
  console.log('  2. Run: github-agent start    # Start the background daemon');
  console.log('  3. Run: github-agent status   # Check queued issues\n');
}

interface ConfigObject {
  github_token: string;
  targets: {
    organizations: string[];
    repositories: string[];
  };
  scan: {
    interval_minutes: number;
    filters: {
      state: string;
      labels: string[];
    };
  };
  paths: {
    repos_dir: string;
    data_dir: string;
  };
  notifications: {
    enabled: boolean;
    on_new_issue: boolean;
    on_scan_complete: boolean;
    on_error: boolean;
  };
}

function buildConfig(answers: InitAnswers): ConfigObject {
  const organizations = answers.organizations
    ? answers.organizations.split(',').map(o => o.trim()).filter(Boolean)
    : [];

  const repositories = answers.repositories
    ? answers.repositories.split(',').map(r => r.trim()).filter(Boolean)
    : [];

  const labels = answers.labels
    ? answers.labels.split(',').map(l => l.trim()).filter(Boolean)
    : [];

  return {
    github_token: answers.githubToken,
    targets: {
      organizations,
      repositories,
    },
    scan: {
      interval_minutes: answers.scanInterval,
      filters: {
        state: answers.issueState,
        labels,
      },
    },
    paths: {
      repos_dir: '~/.github-agent/repos',
      data_dir: '~/.github-agent/data',
    },
    notifications: {
      enabled: answers.enableNotifications,
      on_new_issue: true,
      on_scan_complete: false,
      on_error: true,
    },
  };
}

function generateYaml(config: ConfigObject): string {
  const lines: string[] = [
    '# GitHub Issue Agent Configuration',
    '# Generated by github-agent init',
    '',
    '# GitHub Personal Access Token',
    `github_token: "${config.github_token}"`,
    '',
    '# What to monitor',
    'targets:',
  ];

  // Organizations
  if (config.targets.organizations.length > 0) {
    lines.push('  organizations:');
    for (const org of config.targets.organizations) {
      lines.push(`    - ${org}`);
    }
  } else {
    lines.push('  organizations: []');
  }

  // Repositories
  if (config.targets.repositories.length > 0) {
    lines.push('  repositories:');
    for (const repo of config.targets.repositories) {
      lines.push(`    - ${repo}`);
    }
  } else {
    lines.push('  repositories: []');
  }

  lines.push('');
  lines.push('# Scanning options');
  lines.push('scan:');
  lines.push(`  interval_minutes: ${config.scan.interval_minutes}`);
  lines.push('  filters:');
  lines.push(`    state: ${config.scan.filters.state}`);

  if (config.scan.filters.labels.length > 0) {
    lines.push('    labels:');
    for (const label of config.scan.filters.labels) {
      lines.push(`      - ${label}`);
    }
  } else {
    lines.push('    labels: []');
  }

  lines.push('');
  lines.push('# Storage paths');
  lines.push('paths:');
  lines.push(`  repos_dir: ${config.paths.repos_dir}`);
  lines.push(`  data_dir: ${config.paths.data_dir}`);

  lines.push('');
  lines.push('# Notifications');
  lines.push('notifications:');
  lines.push(`  enabled: ${config.notifications.enabled}`);
  lines.push(`  on_new_issue: ${config.notifications.on_new_issue}`);
  lines.push(`  on_scan_complete: ${config.notifications.on_scan_complete}`);
  lines.push(`  on_error: ${config.notifications.on_error}`);
  lines.push('');

  return lines.join('\n');
}
