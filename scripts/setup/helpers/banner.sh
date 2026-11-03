#!/usr/bin/env bash
# banner.sh - Luna's mark in the terminal: the eclipse (a cream moon, the dark island sliding over
# it) with the prompt eyes, beside LUNA in block letters. Drawn from the same geometry as
# scripts/mark.mjs (its 1024 grid, cropped to the glyph's 232..778), two pixels per character cell
# with half blocks. Pure bash 3.2 arithmetic: it runs before Node is installed.
#
#   banner_show [subtitle]   animated on a terminal; one still frame otherwise
#   LUNA_NO_ANIMATION=1      always the still frame; NO_COLOR drops the colours
source "$(dirname "${BASH_SOURCE[0]}")/colors-style.sh"

BANNER_PX=28  # pixels a side: 28 columns by 14 rows of half blocks
BANNER_LUNA=(
  "██╗     ██╗   ██╗███╗   ██╗ █████╗ "
  "██║     ██║   ██║████╗  ██║██╔══██╗"
  "██║     ██║   ██║██╔██╗ ██║███████║"
  "██║     ██║   ██║██║╚██╗██║██╔══██║"
  "███████╗╚██████╔╝██║ ╚████║██║  ██║"
  "╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝"
)

# banner_rgb R G B FALLBACK256: a foreground colour, true colour when the terminal says it has it.
banner_rgb() {
  [ -n "${NO_COLOR:-}" ] && return 0
  case "${COLORTERM:-}" in
    truecolor|24bit) printf '\033[38;2;%s;%s;%sm' "$1" "$2" "$3" ;;
    *) printf '\033[38;5;%sm' "$4" ;;
  esac
}
banner_reset() { [ -n "${NO_COLOR:-}" ] || printf '\033[0m'; }

# banner_lit X Y SHIFT EYES: 0 when the mark covers the point (units of the 1024 grid). SHIFT is how
# far the island still is from its place; EYES draws the prompt (the chevron and the cursor).
banner_lit() {
  local x=$1 y=$2 shift=$3 eyes=$4 dx dy
  if [ "$eyes" -ge 1 ]; then
    # The chevron, M470 522 l54 43 -54 43, stroked 44 wide: within 22 of either segment.
    banner_near "$x" "$y" 470 522 524 565 && return 0
    banner_near "$x" "$y" 524 565 470 608 && return 0
    # The cursor, 570..646 by 582..626, when it is on.
    [ "$eyes" -eq 1 ] && [ "$x" -ge 570 ] && [ "$x" -le 646 ] && [ "$y" -ge 582 ] && [ "$y" -le 626 ] && return 0
  fi
  dx=$((x - 482)); dy=$((y - 482))
  [ $((dx * dx + dy * dy)) -le 62500 ] || return 1          # the moon, r 250
  dx=$((x - 550 - shift)); dy=$((y - 550 - shift))
  [ $((dx * dx + dy * dy)) -gt 51984 ]                       # not under the island, r 228
}

# banner_near X Y AX AY BX BY: the point is within 22 of the segment A-B.
banner_near() {
  local px=$(($1 - $3)) py=$(($2 - $4)) vx=$(($5 - $3)) vy=$(($6 - $4)) dot len cross
  dot=$((px * vx + py * vy)); len=$((vx * vx + vy * vy))
  if [ "$dot" -le 0 ]; then [ $((px * px + py * py)) -le 484 ]; return; fi
  if [ "$dot" -ge "$len" ]; then px=$(($1 - $5)); py=$(($2 - $6)); [ $((px * px + py * py)) -le 484 ]; return; fi
  cross=$((px * vy - py * vx))
  [ $((cross * cross)) -le $((484 * len)) ]
}

# banner_frame SHIFT EYES REVEAL SUBTITLE [ERASE]: one frame, BANNER_PX/2 lines; REVEAL is how many
# columns of LUNA show; ERASE clears each line's tail, for an animation drawing over its last frame.
banner_frame() {
  local shift=$1 eyes=$2 reveal=$3 subtitle=$4 erase=${5:-} row col x y top bottom line cell
  local moon text dim first=$(((BANNER_PX / 2 - 6) / 2))
  moon=$(banner_rgb 252 243 220 230); dim=$(banner_rgb 140 140 170 103)
  for ((row = 0; row < BANNER_PX / 2; row++)); do
    line="  $moon"
    for ((col = 0; col < BANNER_PX; col++)); do
      x=$((232 + (2 * col + 1) * 546 / (2 * BANNER_PX)))
      y=$((232 + (4 * row + 1) * 546 / (2 * BANNER_PX)))
      banner_lit "$x" "$y" "$shift" "$eyes" && top=1 || top=0
      y=$((232 + (4 * row + 3) * 546 / (2 * BANNER_PX)))
      banner_lit "$x" "$y" "$shift" "$eyes" && bottom=1 || bottom=0
      case "$top$bottom" in 11) cell="█" ;; 10) cell="▀" ;; 01) cell="▄" ;; *) cell=" " ;; esac
      line="$line$cell"
    done
    line="$line$(banner_reset)   "
    # LUNA beside the middle of the mark, violet at the top to cream at the bottom; the subtitle under it.
    if [ "$row" -ge "$first" ] && [ "$row" -le $((first + 5)) ]; then
      local i=$((row - first))
      text=$(banner_rgb $((167 + i * 17)) $((139 + i * 21)) $((250 - i * 6)) $((141 + i * 18)))
      line="$line$text${BANNER_LUNA[$i]:0:$reveal}$(banner_reset)"
    elif [ "$row" -eq $((first + 7)) ] && [ "$reveal" -gt 0 ]; then
      line="$line$dim${subtitle:0:$reveal}$(banner_reset)"
    fi
    if [ -n "$erase" ]; then printf '%s\033[K\n' "$line"; else printf '%s\n' "${line%"${line##*[! ]}"}"; fi
  done
}

# banner_show [subtitle]: the animation on a terminal, the last frame anywhere else.
banner_show() {
  local subtitle="${1:-}" width=${#BANNER_LUNA[0]} lines=$((BANNER_PX / 2)) step
  # Not a terminal: no colours either, so a log or a pipe gets plain text.
  [ -t 1 ] || local NO_COLOR=1
  if [ ! -t 1 ] || [ -n "${LUNA_NO_ANIMATION:-}${NO_COLOR:-}${CI:-}" ]; then
    echo; banner_frame 0 1 "$width" "$subtitle"
    return
  fi
  # The cursor is hidden while frames are drawn: give it back on Ctrl-C too.
  trap 'printf "\033[?25h\033[0m\n"; exit 130' INT
  printf '\033[?25l'; echo
  # The island slides over the moon, then the prompt opens its eyes, then LUNA sweeps in.
  for step in 360 250 170 110 65 30 10 0; do
    banner_frame "$step" 0 0 "$subtitle" erase; printf '\033[%sA' "$lines"; sleep 0.04
  done
  for step in 1 0 1; do
    banner_frame 0 "$((step + 1))" 0 "$subtitle" erase; printf '\033[%sA' "$lines"; sleep 0.12
  done
  for ((step = 4; step < width + 4; step += 5)); do
    banner_frame 0 1 "$step" "$subtitle" erase; printf '\033[%sA' "$lines"; sleep 0.02
  done
  banner_frame 0 1 "$width" "$subtitle" erase
  printf '\033[?25h'
  trap - INT
}
