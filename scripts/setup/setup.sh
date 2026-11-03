#!/usr/bin/env bash
# setup.sh - `make setup`: everything from a fresh Mac to a running machine and board, one step at a
# time. Each step is its own make target too, and every step is safe to run again.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

STEPS=7
ui_header "Luna setup" "Tools, credentials, integrations, the machine, the board and your repos."

ui_step 1 $STEPS "Tools"
bash "$SETUP_DIR/tools.sh"
rust_path

ui_step 2 $STEPS "Dependencies"
(cd "$ROOT" && ui_spin "pnpm install" pnpm install --frozen-lockfile)

ui_step 3 $STEPS "Credentials"
bash "$SETUP_DIR/credentials.sh"

ui_step 4 $STEPS "Integrations"
bash "$SETUP_DIR/integrations.sh"

ui_step 5 $STEPS "The machine"
if ui_confirm "Build the stage images and start Postgres + the machine now? The first build takes a while (about 5 GB)." yes; then
  (cd "$ROOT" && pnpm start)
else
  info "Later: make up"
fi

ui_step 6 $STEPS "The board"
if ui_confirm "Build the board and link it into herdr?" yes; then
  (cd "$ROOT" && ui_spin "pnpm board:link" pnpm board:link)
else
  info "Later: make board"
fi

ui_step 7 $STEPS "Your repos"
while ui_confirm "Write a luna.yaml for a repo?"; do
  bash "$SETUP_DIR/luna-yaml.sh" || true
done

echo
bash "$SETUP_DIR/doctor.sh" || true
echo
info "Open the board: herdr plugin action invoke hardness.board.open"
info "Run any step again: make tools | credentials | integrations | luna-yaml REPO=<path> | up | board | doctor"
