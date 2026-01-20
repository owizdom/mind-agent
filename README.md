# Mind Agent

A background agent that monitors GitHub organizations and repositories for issues, prepares context, and queues them for you to fix using your AI coding assistant (Cursor, Copilot, etc.).

[![npm version](https://badge.fury.io/js/@parallel-labs%2Fmind-agent.svg)](https://www.npmjs.com/package/@parallel-labs/mind-agent)

## Features

- **Multi-target monitoring** - Watch entire organizations or specific repositories
- **Background daemon** - Runs continuously, polling for new issues
- **Smart context building** - Automatically gathers relevant code files for each issue
- **Branch management** - Creates feature branches for each issue
- **Desktop notifications** - macOS notifications when new issues are found
- **AI-ready workflow** - Opens issues in Cursor/VSCode with context ready for your AI assistant

## Quick Start

```bash
# Install globally
npm install -g @parallel-labs/mind-agent

# Initialize configuration
github-agent init

# Start the background daemon
github-agent start

# Check status
github-agent status
```

## Installation

### npm (recommended)

```bash
npm install -g @parallel-labs/mind-agent
```

### npx (no install)

```bash
npx @parallel-labs/mind-agent init
```

### From source

```bash
git clone https://github.com/owizdom/mind-agent.git
cd mind-agent
npm install
npm run build
npm link
```

## Configuration

Run the interactive setup wizard:

```bash
github-agent init
```

This creates a `github-agent.yaml` file in your current directory:

```yaml
# GitHub Personal Access Token
github_token: ${GITHUB_TOKEN}

# What to monitor
targets:
  organizations:
    - your-org
    - another-org
  repositories:
    - owner/specific-repo

# Scanning options
scan:
  interval_minutes: 5
  filters:
    state: open
    labels: []  # Empty = all labels

# Storage paths
paths:
  repos_dir: ~/.github-agent/repos
  data_dir: ~/.github-agent/data

# Notifications
notifications:
  enabled: true
  on_new_issue: true
  on_scan_complete: false
  on_error: true
```

### Environment Variables

You can set `GITHUB_TOKEN` as an environment variable instead of putting it in the config file:

```bash
export GITHUB_TOKEN=ghp_your_token_here
```

### Getting a GitHub Token

1. Go to [GitHub Settings > Tokens](https://github.com/settings/tokens)
2. Generate a new token (classic)
3. Select scopes: `repo` (full access to repositories)
4. Copy the token and add it to your config or environment

## Usage

### Commands

| Command | Description |
|---------|-------------|
| `github-agent init` | Interactive setup wizard |
| `github-agent start` | Start background daemon |
| `github-agent start -f` | Start in foreground (for debugging) |
| `github-agent stop` | Stop the daemon |
| `github-agent status` | Show queued issues and agent status |
| `github-agent scan` | Run a single scan immediately |
| `github-agent open <issue>` | Open issue in Cursor/VSCode |
| `github-agent push <issue>` | Push your fix |
| `github-agent diff <issue>` | Show diff for an issue |
| `github-agent logs` | Show daemon logs |
| `github-agent logs -f` | Follow log output |

### Workflow Example

```bash
# 1. Initialize and start
github-agent init
github-agent start

# 2. Agent finds issues and notifies you...
# 🔔 "New issue in my-org/my-repo: Bug in authentication"

# 3. Check queued issues
github-agent status

# 4. Open an issue to fix
github-agent open 42
# Opens Cursor with the repo, context file ready

# 5. Ask your AI assistant to fix it
# "Fix issue #42: Bug in authentication"

# 6. Push your fix
github-agent push 42

# 7. Create PR on GitHub (link shown after push)
```

### Issue Reference Formats

You can reference issues in multiple ways:

```bash
# By issue number (finds across all repos)
github-agent open 42

# By repo#number
github-agent open my-repo#42

# By full reference
github-agent open owner/repo#42
```

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    Background Daemon                         │
├─────────────────────────────────────────────────────────────┤
│  1. Poll GitHub API for issues (every N minutes)            │
│  2. Store new issues in local SQLite database               │
│  3. Clone repositories on-demand                            │
│  4. Create feature branch: fix/issue-{number}-{slug}        │
│  5. Build context file with relevant code                   │
│  6. Send desktop notification                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    When You Return                           │
├─────────────────────────────────────────────────────────────┤
│  1. Run: github-agent status                                │
│  2. Run: github-agent open 42                               │
│  3. Cursor opens with context → Ask AI to fix               │
│  4. Run: github-agent push 42                               │
│  5. Create PR on GitHub                                     │
└─────────────────────────────────────────────────────────────┘
```

## Data Storage

All data is stored locally:

| Path | Description |
|------|-------------|
| `~/.github-agent/repos/` | Cloned repositories |
| `~/.github-agent/data/github-agent.db` | SQLite database |
| `~/.github-agent/data/github-agent.log` | Log file |
| `~/.github-agent/data/tasks/` | Context files for issues |
| `~/.github-agent/daemon.pid` | Daemon process ID |

## Advanced Configuration

### Filter by Labels

Only monitor issues with specific labels:

```yaml
scan:
  filters:
    state: open
    labels:
      - bug
      - help wanted
      - good first issue
```

### Custom Storage Paths

```yaml
paths:
  repos_dir: /path/to/repos
  data_dir: /path/to/data
```

### Disable Notifications

```yaml
notifications:
  enabled: false
```

## Troubleshooting

### Daemon won't start

Check if it's already running:

```bash
github-agent status
```

Check logs for errors:

```bash
github-agent logs
```

### GitHub API rate limiting

The agent polls every 5 minutes by default. If you're hitting rate limits, increase the interval:

```yaml
scan:
  interval_minutes: 15
```

### Config not found

Make sure you're in the directory with `github-agent.yaml` or one of its parent directories. The agent searches upward for the config file.

## Contributing

Contributions welcome! Please open an issue or PR.

## License

MIT
