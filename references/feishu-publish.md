# Optional Feishu publishing

See [setup](../docs/SETUP.md#feishu). This integration is opt-in.
Use `python scripts/publish_feishu.py --report <report.md> --title <title>`.
It creates a new Wiki document and verifies the resulting body. Wiki scopes and
user authentication are required; the default does not silently use Drive.
`--allow-drive-fallback` explicitly enables that alternative.
IM is disabled unless `--notify` is supplied. No hardcoded recipient exists.
Return the actual verified Wiki URL; do not invent links after failures.
