# Hex-Rays IDA MCP

Windows lifecycle fixes for the [official Hex-Rays IDA MCP Server](https://github.com/HexRaysSA/ida-mcp), maintained in [wondercrash/ida-mcp](https://github.com/wondercrash/ida-mcp). See the upstream [announcement](https://hex-rays.com/blog/hex-rays-ida-mcp-server) for background.

## Installation

### Requirements

- Installed in your PATH
  - [Git](https://git-scm.com/)
  - [uv](https://github.com/astral-sh/uv)
- IDA 9.4 or higher with idalib and Python 3.11+
- We recommend disabling other IDA MCP servers to reduce agent confusion

### Automatic installation

Install the Hex-Rays IDA MCP using [hcli](https://hcli.docs.hex-rays.com/):

```bash
uvx ida-hcli mcp install
# or if you have hcli installed:
hcli mcp install
```

This will install the GUI plugin and interactively offer you to install the supported agent plugins.

### Manual installation

<details>

<summary>Manual installation instructions...</summary>

#### IDA GUI Plugin

To support IDA GUI instances when using IDA MCP, install the plugin:

```bash
uvx ida-hcli plugin install ida-mcp@https://github.com/HexRaysSA/ida-mcp
# or if you have hcli installed:
hcli plugin install ida-mcp@https://github.com/HexRaysSA/ida-mcp
```

_Note_: Without the GUI plugin, IDA MCP will still work headlessly.

#### [Claude Code](https://claude.com/product/claude-code)

```bash
# Add Hex-Rays marketplace
claude plugin marketplace add HexRaysSA/claude-marketplace
# Install plugin
claude plugin install ida-mcp@HexRaysSA
# Update to latest version
claude plugin update ida-mcp@HexRaysSA
```

#### [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)

```bash
# Add Hex-Rays marketplace
codex plugin marketplace add HexRaysSA/codex-marketplace
# Install plugin
codex plugin add ida-mcp@HexRaysSA
```

#### [GitHub Copilot CLI](https://github.com/features/copilot/cli)

```bash
# Add Hex-Rays marketplace
copilot plugin marketplace add HexRaysSA/copilot-marketplace
# Install plugin
copilot plugin install ida-mcp@HexRaysSA
# Update to latest version
copilot plugin update ida-mcp
```

#### [Pi](https://pi.dev/)

```bash
# Install extension
pi install git:github.com/wondercrash/ida-mcp@fix/windows-server-lifecycle
# Update to latest version
pi update --extensions
```

#### [oh-my-pi](https://github.com/can1357/oh-my-pi)

```bash
# Install extension
omp plugin install github:wondercrash/ida-mcp#fix/windows-server-lifecycle
# Update to latest version
omp plugin upgrade ida-mcp
```

This fork fixes Pi/OMP startup and shutdown on Windows. On first use, the
extension prepares a cached Python environment outside the installed package.
Later starts reuse it without running `uv sync`; dependency or version changes
select a new environment instead of replacing files held by another session.
Concurrent first starts share preparation. The server runs directly through
Python, without `uv` or the `ida-mcp.exe` launcher in its runtime process tree.

Environments live under `%LOCALAPPDATA%/ida-mcp/envs` on Windows,
`~/Library/Caches/ida-mcp/envs` on macOS, and
`${XDG_CACHE_HOME:-~/.cache}/ida-mcp/envs` on Linux. Old environments are retained
to avoid disrupting running servers; remove unused environments only after all
sessions using them have exited.

Shutdown closes stdin rather than forcibly killing the server or its workers,
allowing Nexus to save databases and release this session's leases without
disrupting another client. Do not configure a second IDA MCP JSON server for
the same Pi/OMP extension.

#### Other agents

Configure a regular stdio MCP server in your MCP JSON configuration:

```json
{
  "mcpServers": {
    "ida": {
      "command": "uvx",
      "args": [
        "--exclude-newer=1s",
        "ida-mcp",
        "stdio",
        "--agent=my-agent"
      ]
    }
  }
}
```

`uvx` resolves the latest stable `ida-mcp` release from PyPI, so this
configuration does not need to be updated for each release.

`--agent=my-agent` is a human-chosen label (like `claude-code`, `cursor`,
`my-custom-agent`, etc.) used to differentiate sessions in the dashboard.

</details>

## CLI

```bash
# MCP server over standard input/output
uvx ida-mcp stdio --agent=my-agent

# MCP server over Streamable HTTP
uvx ida-mcp http --host 127.0.0.1 --port 8737

# Inspect session log
uvx ida-mcp dashboard --open

# Export session logs for troubleshooting
uvx ida-mcp logs
```

## Usage

Start your agent harness and ask it something like:

> Reverse /path/to/sample.elf for me in IDA

To test the GUI integration, open something in IDA and ask your harness:

> What do I have open in the IDA GUI?

## Developers: IDA Nexus

The IDA MCP project is built on [IDA Nexus](https://github.com/HexRaysSA/ida-nexus),
which allows multiple clients to seamlessly share and operate on IDA databases.

You can build your own tools on top of the `ida-nexus` library, see
[the documentation](https://github.com/HexRaysSA/ida-nexus/blob/main/README.md#python-package-developers)
for more information.
