#!/bin/bash
set -e
cd $HOME/git/codex-slack-apprentice
# Do this first:
# npm install typescript --save-dev
npm run build
npm start
