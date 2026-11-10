Only `.env.example` belongs in Git. The setup wizard saves real values in
`~/.config/deep-research/.env` (directory 0700, file 0600).
Override with `DEEP_RESEARCH_CONFIG_DIR` or `DEEP_RESEARCH_ENV_FILE`.
The file is data, never a shell script: no command expansion or variable interpolation.
Existing process variables take precedence. Never commit browser profiles, research
outputs, lark-cli authentication files, or provider configuration files.
