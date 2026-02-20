#!/bin/bash
# Worker initialization script (standalone jinn-node repo)
# Run before worker starts to configure environment from Railway env vars

set -e

# =============================================================================
# Git Identity Configuration
# =============================================================================
# Git requires user.name and user.email for commits. Configure from env vars.
# This persists to ~/.gitconfig on the volume.

if [ -n "$GIT_AUTHOR_NAME" ]; then
  git config --global user.name "$GIT_AUTHOR_NAME"
  echo "[init] Set git user.name to: $GIT_AUTHOR_NAME"
fi

if [ -n "$GIT_AUTHOR_EMAIL" ]; then
  git config --global user.email "$GIT_AUTHOR_EMAIL"
  echo "[init] Set git user.email to: $GIT_AUTHOR_EMAIL"
fi

# =============================================================================
# SSH Known Hosts (GitHub)
# =============================================================================
# Pre-populate known_hosts to avoid interactive prompts during git clone
# Only if ~/.ssh doesn't exist or known_hosts is missing

if [ ! -f ~/.ssh/known_hosts ] || ! grep -q "github.com" ~/.ssh/known_hosts 2>/dev/null; then
  mkdir -p ~/.ssh
  chmod 700 ~/.ssh
  ssh-keyscan -t ed25519,rsa github.com >> ~/.ssh/known_hosts 2>/dev/null
  echo "[init] Added github.com to known_hosts"
fi

# =============================================================================
# Git Credentials (HTTPS with GitHub Token)
# =============================================================================
# Pre-configure git credentials for HTTPS push operations
# This avoids needing to write credentials during first push

if [ -n "$GITHUB_TOKEN" ]; then
  # Configure git to use credential store
  git config --global credential.helper store

  # Write GitHub credentials (append if exists, create otherwise)
  CRED_LINE="https://${GITHUB_TOKEN}:x-oauth-basic@github.com"
  CRED_FILE="$HOME/.git-credentials"

  if [ -f "$CRED_FILE" ]; then
    # Only add if not already present
    if ! grep -q "github.com" "$CRED_FILE" 2>/dev/null; then
      echo "$CRED_LINE" >> "$CRED_FILE"
      echo "[init] Added GitHub credentials to .git-credentials"
    fi
  else
    echo "$CRED_LINE" > "$CRED_FILE"
    chmod 600 "$CRED_FILE"
    echo "[init] Created .git-credentials with GitHub token"
  fi
fi

# =============================================================================
# Workspace Directory
# =============================================================================
# Ensure workspace directory exists if configured

if [ -n "$JINN_WORKSPACE_DIR" ]; then
  mkdir -p "$JINN_WORKSPACE_DIR"
  echo "[init] Ensured workspace dir exists: $JINN_WORKSPACE_DIR"
fi

# =============================================================================
# Gemini CLI Directory
# =============================================================================
# Ensure ~/.gemini exists for OAuth credential storage

mkdir -p ~/.gemini

# If GEMINI_API_KEY is set, always configure Gemini CLI for API key auth.
# Force-overwrite settings.json to prevent stale OAuth config on the volume
# from triggering the interactive OAuth prompt in non-interactive containers.
if [ -n "$GEMINI_API_KEY" ]; then
  cat > ~/.gemini/settings.json << 'SETTINGS'
{
  "security": {
    "auth": {
      "selectedType": "gemini-api-key"
    }
  }
}
SETTINGS
  # Also remove stale OAuth credentials that may override API key auth
  rm -f ~/.gemini/oauth_creds.json ~/.gemini/google_accounts.json
  echo "[init] Configured Gemini CLI for API key auth (forced)"
fi

echo "[init] Ensured ~/.gemini exists"

echo "[init] Worker initialization complete"
