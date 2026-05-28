#!/bin/sh
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required for chat commands."
  echo "Install it from https://nodejs.org/ and run this launcher again."
  read -r -p "Press Enter to close."
  exit 1
fi

if [ -z "$OPENAI_API_KEY" ]; then
  echo "OPENAI_API_KEY is not set."
  echo "Chat will still understand a few basic read-only commands, but OpenAI parsing will be disabled."
  printf "Paste OpenAI API key for this session, or press Enter to skip: "
  read -r OPENAI_API_KEY
  export OPENAI_API_KEY
fi

open "http://localhost:8787" >/dev/null 2>&1 || true
node server.mjs
