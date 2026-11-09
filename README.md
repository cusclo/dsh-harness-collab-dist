# DSH Harness Collaboration

Install a Collaboration Leader preset in DeepSeek Harness. DeepSeek delegates implementation and rework to Codex and sends the current Git diff to Antigravity CLI (`agy`) for review. It returns the final diff and test results to the original session.

## Requirements

- DeepSeek Harness **0.2.2-rc.1** and Node.js 24.9 or later for the standalone CLI.
- Native Codex authentication, an installed and signed-in Antigravity CLI, and a configured DeepSeek model in Harness.
- The agy reviewer defaults to `gemini-3.8-flash-medium`. If needed, set `DSH_COLLAB_AGY_MODEL` to a model from `agy models`. If Harness cannot find agy on PATH, set `DSH_COLLAB_AGY_BIN` to its absolute path before launching Harness.

## Install

Open **Plugins → Add plugin** in Harness and enter this Git install spec:

```text
git+https://github.com/cusclo/dsh-harness-collab-dist.git#v0.1.0
```

For the Discover tab, enable **Custom plugin indexes** and add:

```text
https://raw.githubusercontent.com/cusclo/dsh-harness-collab-dist/main/index.json
```

Open a new session in a clean Git checkout and select **Collaboration Leader**. Give it a scoped change and a test command. Confirm that the diff is appropriate to send to Antigravity before delegating review. The review tool sends the tracked diff and its Git base, runs agy in plan mode with its sandbox enabled, and checks the Git snapshot after the review.

The published bundle contains the leader preset, the Git snapshot and review tools, and a headless example. The official Codex provider is pinned to the same Harness version. If the bundled Codex rejects your configured model, use a profile overlay to set a supported model for `collab-codex`. Keep the other fields when replacing the row's configuration:

```yaml
- id: collab-codex
  config:
    providerName: collab-codex
    permissionMode: approve-for-me
    model: YOUR_SUPPORTED_CODEX_MODEL
```

[MIT](LICENSE)
