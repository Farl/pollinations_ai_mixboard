#!/usr/bin/env bash
set -euo pipefail

REPO="Farl/pollinations_ai_mixboard"

if [[ -z "${POLLINATIONS_API_KEY:-}" ]]; then
  echo "ERROR: POLLINATIONS_API_KEY is required."
  echo "Usage: POLLINATIONS_API_KEY=... [GH_MODELS_TOKEN=...] ./setup_keys.sh"
  exit 1
fi

GH_MODELS_TOKEN_VALUE="${GH_MODELS_TOKEN:-}"

cat > config.runtime.js <<EOF
window.MIXBOARD_CONFIG = {
  AI_PROVIDER: "pollinations",
  POLLINATIONS_API_BASE_URL: "https://gen.pollinations.ai",
  POLLINATIONS_IMAGE_MODEL: "kontext",
  POLLINATIONS_API_KEY: "${POLLINATIONS_API_KEY}",
  GH_MODELS_TOKEN: "${GH_MODELS_TOKEN_VALUE}"
};
EOF

echo "Updated local config.runtime.js"

printf %s "${POLLINATIONS_API_KEY}" | gh secret set POLLINATIONS_API_KEY --repo "${REPO}"
echo "Set GitHub secret: POLLINATIONS_API_KEY"

if [[ -n "${GH_MODELS_TOKEN_VALUE}" ]]; then
  printf %s "${GH_MODELS_TOKEN_VALUE}" | gh secret set GH_MODELS_TOKEN --repo "${REPO}"
  echo "Set GitHub secret: GH_MODELS_TOKEN"
fi

echo "Done. Local + GitHub key setup complete."
